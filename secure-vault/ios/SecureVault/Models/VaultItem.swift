import Foundation

/// 帳密項目（解密後只存在記憶體中）。
struct VaultItem: Codable, Identifiable, Hashable {
    enum Kind: String, Codable, CaseIterable {
        case login, note
        var label: String { self == .login ? "帳號密碼" : "安全筆記" }
        var icon: String { self == .login ? "key.fill" : "note.text" }
    }

    var id: String = UUID().uuidString.lowercased()
    var kind: Kind = .login
    var name: String = ""
    var username: String = ""
    var password: String = ""
    var url: String = ""
    var notes: String = ""
    var updatedAt: Date = Date()
    /// 伺服器上的版本號，用來偵測多台裝置同時修改（不加密，也不寫進密文）
    var revision: Int = 0

    enum CodingKeys: String, CodingKey {
        case id, kind, name, username, password, url, notes, updatedAt
    }
}

/// 照片/影片的中繼資料，整包加密後才上傳（伺服器看不到檔名、類型或 fileKey）。
struct FileMeta: Codable {
    enum Kind: String, Codable { case image, video, other }
    var name: String
    var mime: String
    var kind: Kind
    var size: Int
    var chunkCount: Int
    var fileKey: String // base64
    var createdAt: Date
}

struct MediaFile: Identifiable, Hashable {
    let id: String
    let meta: FileMeta
    let chunkSizes: [Int]
    let hasThumb: Bool

    static func == (a: MediaFile, b: MediaFile) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

enum PasswordGenerator {
    static func generate(length: Int = 20, symbols: Bool = true) -> String {
        // 去掉容易混淆的 0/O、1/l/I
        var chars = Array("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789")
        if symbols { chars += Array("!@#$%^&*-_=+?") }
        // SystemRandomNumberGenerator 在 Apple 平台上是密碼學安全的亂數
        var rng = SystemRandomNumberGenerator()
        return String((0..<length).map { _ in chars.randomElement(using: &rng)! })
    }
}
