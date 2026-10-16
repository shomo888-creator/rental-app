import Foundation
import CryptoKit
import Sodium

/// 所有加密都在 iPhone 上完成。這份實作與 server/test/vault-crypto.js 的格式完全一致。
///
/// 金鑰架構：
///   主密碼 ──Argon2id──▶ 主金鑰 ─┬─HKDF──▶ authKey（送給伺服器驗證身分，伺服器無法用它解密）
///                                  └─HKDF──▶ encKey（只留在手機）──包住──▶ vaultKey（資料金鑰）
///   vaultKey ──加密──▶ 每筆帳密項目、每個檔案的中繼資料（內含各檔案自己的 fileKey）
///   fileKey  ──加密──▶ 照片/影片的每個 4MB 區塊與縮圖
enum VaultCrypto {
    private static let sodium = Sodium()

    static let keyBytes = 32
    static let saltBytes = 16
    static let chunkSize = 4 * 1024 * 1024
    /// 每段密文額外的長度：24 bytes nonce + 16 bytes 驗證碼
    static let sealOverhead = 40

    /// Argon2id 參數下限。伺服器若回傳更弱的參數（可能是被入侵後想降低破解難度）就拒絕登入。
    static let minOps = 3
    static let minMem = 64 * 1024 * 1024

    struct KDFParams: Codable, Equatable {
        var salt: String // base64
        var ops: Int
        var mem: Int

        static func fresh() -> KDFParams {
            KDFParams(salt: Data(randomBytes(saltBytes)).base64EncodedString(), ops: minOps, mem: minMem)
        }

        func validate() throws {
            guard ops >= VaultCrypto.minOps, mem >= VaultCrypto.minMem,
                  let s = Data(base64Encoded: salt), s.count == VaultCrypto.saltBytes
            else { throw VaultError.weakKDF }
        }
    }

    struct DerivedKeys {
        let authKey: [UInt8]
        let encKey: [UInt8]
    }

    enum AAD {
        static let vaultKey = "secure-vault/vault-key/v1"
        static func item(_ id: String) -> String { "secure-vault/item/v1/\(id)" }
        static func fileMeta(_ id: String) -> String { "secure-vault/file-meta/v1/\(id)" }
        static func chunk(_ id: String, _ i: Int, last: Bool) -> String {
            "secure-vault/chunk/v1/\(id)/\(i)/\(last ? 1 : 0)"
        }
        static func thumb(_ id: String) -> String { "secure-vault/thumb/v1/\(id)" }
    }

    static func randomBytes(_ n: Int) -> [UInt8] {
        sodium.randomBytes.buf(length: n)!
    }

    static func randomKey() -> [UInt8] { randomBytes(keyBytes) }

    /// 耗時約 0.3–1 秒、使用 64MB 記憶體（這正是讓暴力破解變貴的原因），請在背景執行緒呼叫。
    static func deriveKeys(password: String, kdf: KDFParams) throws -> DerivedKeys {
        try kdf.validate()
        // NFKC 正規化：同一個中文密碼不論用哪種輸入法打，都得到相同的位元組
        let pw = Array(password.precomposedStringWithCompatibilityMapping.utf8)
        guard let salt = Data(base64Encoded: kdf.salt),
              let master = sodium.pwHash.hash(
                outputLength: keyBytes, passwd: pw, salt: Array(salt),
                opsLimit: kdf.ops, memLimit: kdf.mem, alg: .Argon2ID13)
        else { throw VaultError.crypto }
        return DerivedKeys(authKey: hkdf(master, "secure-vault/auth/v1"),
                           encKey: hkdf(master, "secure-vault/enc/v1"))
    }

    static func deriveRecoveryKeys(_ recoveryKey: [UInt8]) -> DerivedKeys {
        DerivedKeys(authKey: hkdf(recoveryKey, "secure-vault/recovery-auth/v1"),
                    encKey: hkdf(recoveryKey, "secure-vault/recovery-enc/v1"))
    }

    private static func hkdf(_ ikm: [UInt8], _ info: String) -> [UInt8] {
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm),
                                         info: Data(info.utf8), outputByteCount: keyBytes)
        return key.withUnsafeBytes { Array($0) }
    }

    /// XChaCha20-Poly1305：輸出 nonce(24) || 密文 || 驗證碼(16)。
    /// AAD 把密文綁定到「用途 + ID」，被竄改、被搬到別的項目或被截斷都會解密失敗。
    static func seal(_ plaintext: [UInt8], key: [UInt8], aad: String) throws -> [UInt8] {
        let out: [UInt8]? = sodium.aead.xchacha20poly1305ietf.encrypt(
            message: plaintext, secretKey: key, additionalData: Array(aad.utf8))
        guard let out else { throw VaultError.crypto }
        return out
    }

    static func open(_ sealed: [UInt8], key: [UInt8], aad: String) throws -> [UInt8] {
        guard sealed.count >= sealOverhead,
              let out = sodium.aead.xchacha20poly1305ietf.decrypt(
                nonceAndAuthenticatedCipherText: sealed, secretKey: key, additionalData: Array(aad.utf8))
        else { throw VaultError.decryptFailed }
        return out
    }

    static func sealedChunkSizes(fileSize: Int) -> [Int] {
        if fileSize == 0 { return [sealOverhead] }
        let count = (fileSize + chunkSize - 1) / chunkSize
        return (0..<count).map { i in min(chunkSize, fileSize - i * chunkSize) + sealOverhead }
    }

    /// 嘗試清除記憶體中的金鑰（Swift 無法保證完全清除副本，但能縮短殘留時間）。
    static func wipe(_ bytes: inout [UInt8]) {
        sodium.utils.zero(&bytes)
    }
}

/// 復原金鑰的顯示格式：Base32，每 4 個字一組，例如 ABCD-EFGH-...
enum RecoveryKeyFormat {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    static func encode(_ bytes: [UInt8]) -> String {
        var bits = 0, value = 0
        var out = ""
        for b in bytes {
            value = (value << 8) | Int(b)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[(value >> (bits - 5)) & 31])
                bits -= 5
            }
            value &= (1 << bits) - 1 // 只保留還沒用到的位元，避免溢位
        }
        if bits > 0 { out.append(alphabet[(value << (5 - bits)) & 31]) }
        return stride(from: 0, to: out.count, by: 4).map { i in
            let s = out.index(out.startIndex, offsetBy: i)
            let e = out.index(s, offsetBy: min(4, out.count - i))
            return String(out[s..<e])
        }.joined(separator: "-")
    }

    static func decode(_ text: String) -> [UInt8]? {
        let clean = text.uppercased().filter { $0 != "-" && !$0.isWhitespace }
        var bits = 0, value = 0
        var out: [UInt8] = []
        for c in clean {
            guard let v = alphabet.firstIndex(of: c) else { return nil }
            value = (value << 5) | v
            bits += 5
            if bits >= 8 {
                out.append(UInt8((value >> (bits - 8)) & 0xFF))
                bits -= 8
            }
            value &= (1 << bits) - 1
        }
        return out.count == VaultCrypto.keyBytes ? out : nil
    }
}

enum VaultError: LocalizedError {
    case crypto, decryptFailed, weakKDF, wrongPassword

    var errorDescription: String? {
        switch self {
        case .crypto: return "加密元件發生錯誤"
        case .decryptFailed: return "資料解密失敗（可能被竄改）"
        case .weakKDF: return "伺服器回傳的加密參數不安全，已拒絕登入"
        case .wrongPassword: return "主密碼錯誤"
        }
    }
}
