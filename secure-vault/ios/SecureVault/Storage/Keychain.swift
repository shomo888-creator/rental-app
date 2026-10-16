import Foundation
import LocalAuthentication
import Security

/// 敏感資料只存在 iOS Keychain（由 Secure Enclave 保護），且全部設定為：
/// - ThisDeviceOnly：不會跟著 iCloud 或 iTunes 備份到其他裝置
/// - 需要裝置已設定密碼才能存取
enum Keychain {
    private static let service = "SecureVault"

    enum Key: String {
        case sessionToken
        case account          // email + KDF 參數 + 被包住的 vaultKey（離線解鎖用，本身是密文）
        case biometricVaultKey // 只有 Face ID / Touch ID 驗證通過才能讀取
    }

    static func set(_ data: Data, for key: Key) throws {
        delete(key)
        var query = base(key)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
        try check(SecItemAdd(query as CFDictionary, nil))
    }

    static func get(_ key: Key) -> Data? {
        var query = base(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func delete(_ key: Key) {
        SecItemDelete(base(key) as CFDictionary)
    }

    static func deleteAll() {
        [Key.sessionToken, .account, .biometricVaultKey].forEach(delete)
    }

    /// 儲存 vaultKey，之後必須通過「目前登錄的」Face ID 才能讀取。
    /// 若新增或移除了臉孔/指紋（.biometryCurrentSet），這把金鑰會自動失效，必須重新輸入主密碼。
    static func setBiometricVaultKey(_ key: [UInt8]) throws {
        delete(.biometricVaultKey)
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &error)
        else { throw KeychainError.status(errSecParam) }
        var query = base(.biometricVaultKey)
        query[kSecValueData as String] = Data(key)
        query[kSecAttrAccessControl as String] = access
        try check(SecItemAdd(query as CFDictionary, nil))
    }

    /// 會跳出 Face ID。會阻塞執行緒，請在背景呼叫。
    static func biometricVaultKey(reason: String) throws -> [UInt8] {
        let context = LAContext()
        context.localizedReason = reason
        var query = base(.biometricVaultKey)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = context
        var out: CFTypeRef?
        try check(SecItemCopyMatching(query as CFDictionary, &out))
        guard let data = out as? Data else { throw KeychainError.status(errSecItemNotFound) }
        return Array(data)
    }

    static var hasBiometricVaultKey: Bool {
        // 只檢查是否存在，不觸發 Face ID
        let context = LAContext()
        context.interactionNotAllowed = true
        var query = base(.biometricVaultKey)
        query[kSecUseAuthenticationContext as String] = context
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    private static func base(_ key: Key) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key.rawValue,
         kSecAttrSynchronizable as String: false]
    }

    private static func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }
}

enum KeychainError: LocalizedError {
    case status(OSStatus)
    var errorDescription: String? {
        switch self {
        case .status(errSecUserCanceled): return "已取消"
        case .status(errSecAuthFailed): return "生物辨識驗證失敗"
        case .status(let s): return "Keychain 錯誤（\(s)）"
        }
    }
}

/// 存在 Keychain 的帳號資料（不含任何明文金鑰）。
struct StoredAccount: Codable {
    var email: String
    var kdf: VaultCrypto.KDFParams
    var protectedVaultKey: String // base64，被 encKey 包住
}
