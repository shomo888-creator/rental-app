import Foundation
import UIKit

/// 管理登入、上鎖與解鎖。vaultKey 只在「已解鎖」時存在記憶體中，上鎖立即清除。
@MainActor
final class AppState: ObservableObject {
    enum Phase { case loggedOut, locked, unlocked }

    @Published private(set) var phase: Phase = .loggedOut
    @Published var biometricsEnabled = Keychain.hasBiometricVaultKey

    let api = APIClient()
    private(set) var vaultKey: [UInt8]?
    private(set) lazy var vault = VaultStore(app: self)
    private(set) lazy var media = MediaStore(app: self)

    init() {
        if let token = Keychain.get(.sessionToken).flatMap({ String(data: $0, encoding: .utf8) }),
           storedAccount != nil {
            api.token = token
            phase = .locked
        }
        api.onUnauthorized = { [weak self] in
            Task { @MainActor in self?.wipeLocalData() }
        }
        TempFiles.clear()
    }

    var storedAccount: StoredAccount? {
        Keychain.get(.account).flatMap { try? JSONDecoder().decode(StoredAccount.self, from: $0) }
    }

    // MARK: - 註冊

    /// 回傳復原金鑰（只顯示這一次，伺服器沒有它）。
    func register(email: String, password: String, registrationCode: String) async throws -> String {
        let kdf = VaultCrypto.KDFParams.fresh()
        let (keys, vaultKey, recoveryKey) = try await Task.detached(priority: .userInitiated) {
            (try VaultCrypto.deriveKeys(password: password, kdf: kdf),
             VaultCrypto.randomKey(), VaultCrypto.randomKey())
        }.value
        let rec = VaultCrypto.deriveRecoveryKeys(recoveryKey)

        struct Body: Encodable {
            let email, registrationCode, authKey, protectedVaultKey, recoveryAuthKey, recoveryProtectedVaultKey: String
            let kdf: VaultCrypto.KDFParams
        }
        let _: OK = try await api.send("POST", "api/auth/register", body: Body(
            email: email, registrationCode: registrationCode,
            authKey: keys.authKey.base64,
            protectedVaultKey: try VaultCrypto.seal(vaultKey, key: keys.encKey, aad: VaultCrypto.AAD.vaultKey).base64,
            recoveryAuthKey: rec.authKey.base64,
            recoveryProtectedVaultKey: try VaultCrypto.seal(vaultKey, key: rec.encKey, aad: VaultCrypto.AAD.vaultKey).base64,
            kdf: kdf))
        return RecoveryKeyFormat.encode(recoveryKey)
    }

    // MARK: - 登入

    enum LoginResult { case success, needsTotp }

    func login(email: String, password: String, totp: String?) async throws -> LoginResult {
        let email = email.trimmingCharacters(in: .whitespaces).lowercased()
        struct Pre: Encodable { let email: String }
        let pre: PreloginResponse = try await api.send("POST", "api/auth/prelogin", body: Pre(email: email))
        let keys = try await Task.detached(priority: .userInitiated) {
            try VaultCrypto.deriveKeys(password: password, kdf: pre.kdf)
        }.value

        struct Body: Encodable { let email, authKey, deviceName: String; let totp: String? }
        let res: LoginResponse
        do {
            res = try await api.send("POST", "api/auth/login", body: Body(
                email: email, authKey: keys.authKey.base64,
                deviceName: UIDevice.current.name, totp: totp))
        } catch let e as APIClient.ServerError where e.totpRequired == true && totp == nil {
            return .needsTotp
        }
        try res.kdf.validate()
        guard let wrapped = res.protectedVaultKey.base64Bytes else { throw VaultError.crypto }
        let vaultKey = try VaultCrypto.open(wrapped, key: keys.encKey, aad: VaultCrypto.AAD.vaultKey)

        try Keychain.set(Data(res.token.utf8), for: .sessionToken)
        try Keychain.set(JSONEncoder().encode(
            StoredAccount(email: email, kdf: res.kdf, protectedVaultKey: res.protectedVaultKey)), for: .account)
        api.token = res.token
        unlock(with: vaultKey)
        return .success
    }

    // MARK: - 解鎖（離線也可以，不需要連線）

    func unlock(password: String) async throws {
        guard let account = storedAccount, let wrapped = account.protectedVaultKey.base64Bytes else {
            throw VaultError.crypto
        }
        let vaultKey = try await Task.detached(priority: .userInitiated) {
            let keys = try VaultCrypto.deriveKeys(password: password, kdf: account.kdf)
            do { return try VaultCrypto.open(wrapped, key: keys.encKey, aad: VaultCrypto.AAD.vaultKey) }
            catch { throw VaultError.wrongPassword }
        }.value
        unlock(with: vaultKey)
    }

    func unlockWithBiometrics() async throws {
        let key = try await Task.detached(priority: .userInitiated) {
            try Keychain.biometricVaultKey(reason: "解鎖 SecureVault")
        }.value
        unlock(with: key)
    }

    func setBiometrics(enabled: Bool) throws {
        if enabled, let vaultKey {
            try Keychain.setBiometricVaultKey(vaultKey)
        } else {
            Keychain.delete(.biometricVaultKey)
        }
        biometricsEnabled = Keychain.hasBiometricVaultKey
    }

    private func unlock(with key: [UInt8]) {
        vaultKey = key
        phase = .unlocked
        Task {
            await vault.load()
            await media.load()
        }
    }

    /// 上鎖：清除記憶體中的金鑰、解密後的資料與暫存檔。
    func lock() {
        guard phase == .unlocked else { return }
        if var key = vaultKey { VaultCrypto.wipe(&key) }
        vaultKey = nil
        vault.clear()
        media.clear()
        TempFiles.clear()
        UIPasteboard.general.items = []
        phase = .locked
    }

    // MARK: - 登出

    func logout(allDevices: Bool = false) async {
        _ = try? await api.send("POST", allDevices ? "api/auth/logout-all" : "api/auth/logout", as: OK.self)
        wipeLocalData()
    }

    private func wipeLocalData() {
        lock()
        Keychain.deleteAll()
        VaultStore.deleteCache()
        api.token = nil
        biometricsEnabled = false
        phase = .loggedOut
    }

    // MARK: - 用復原金鑰重設主密碼

    func recover(email: String, recoveryKey: String, newPassword: String) async throws {
        guard let rk = RecoveryKeyFormat.decode(recoveryKey) else {
            throw APIClient.ServerError(error: "復原金鑰格式不正確")
        }
        let email = email.trimmingCharacters(in: .whitespaces).lowercased()
        let rec = VaultCrypto.deriveRecoveryKeys(rk)

        struct Start: Encodable { let email, recoveryAuthKey: String }
        let start: RecoverStartResponse = try await api.send(
            "POST", "api/auth/recover/start", body: Start(email: email, recoveryAuthKey: rec.authKey.base64))
        guard let wrapped = start.recoveryProtectedVaultKey.base64Bytes else { throw VaultError.crypto }
        let vaultKey = try VaultCrypto.open(wrapped, key: rec.encKey, aad: VaultCrypto.AAD.vaultKey)

        let kdf = VaultCrypto.KDFParams.fresh()
        let keys = try await Task.detached(priority: .userInitiated) {
            try VaultCrypto.deriveKeys(password: newPassword, kdf: kdf)
        }.value
        struct Finish: Encodable {
            let email, recoveryAuthKey, newAuthKey, newProtectedVaultKey: String
            let newKdf: VaultCrypto.KDFParams
        }
        let _: OK = try await api.send("POST", "api/auth/recover/finish", body: Finish(
            email: email, recoveryAuthKey: rec.authKey.base64, newAuthKey: keys.authKey.base64,
            newProtectedVaultKey: try VaultCrypto.seal(vaultKey, key: keys.encKey, aad: VaultCrypto.AAD.vaultKey).base64,
            newKdf: kdf))
    }

    // MARK: - 兩步驟驗證

    /// 需要再輸入一次主密碼。
    func authKey(password: String) async throws -> String {
        guard let account = storedAccount else { throw VaultError.crypto }
        return try await Task.detached(priority: .userInitiated) {
            try VaultCrypto.deriveKeys(password: password, kdf: account.kdf).authKey.base64
        }.value
    }
}

/// 解密後要顯示的照片/影片會暫存在這裡，上鎖、登出或 App 啟動時清空。
enum TempFiles {
    static let dir: URL = {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("decrypted", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.complete])
        return d
    }()

    static func newURL(ext: String) -> URL {
        dir.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
    }

    static func write(_ data: Data, ext: String) throws -> URL {
        let url = newURL(ext: ext)
        try data.write(to: url, options: [.completeFileProtection])
        return url
    }

    static func clear() {
        let fm = FileManager.default
        for url in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] {
            try? fm.removeItem(at: url)
        }
    }
}
