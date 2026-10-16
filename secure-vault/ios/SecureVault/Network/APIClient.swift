import Foundation

/// 與 Zeabur 上後端溝通。只傳送密文與 authKey，從不傳送主密碼或任何解密金鑰。
final class APIClient {
    let baseURL: URL
    var token: String?
    var onUnauthorized: (() -> Void)?

    /// ephemeral：不寫入磁碟快取、不保存 cookie
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.httpCookieStorage = nil
        c.timeoutIntervalForRequest = 60
        c.tlsMinimumSupportedProtocolVersion = .TLSv12
        return URLSession(configuration: c)
    }()

    init() {
        let raw = Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String ?? ""
        guard let url = URL(string: raw), url.scheme == "https" || url.host == "localhost" else {
            fatalError("API_BASE_URL 必須是 https 網址（在 project.yml 設定）")
        }
        baseURL = url
    }

    struct ServerError: LocalizedError, Decodable {
        let error: String
        var totpRequired: Bool?
        var status: Int = 0
        var errorDescription: String? { error }
        enum CodingKeys: String, CodingKey { case error, totpRequired }
    }

    func send<T: Decodable>(_ method: String, _ path: String, body: Encodable? = nil,
                            as: T.Type = T.self) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let (data, resp) = try await session.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            var err = (try? JSONDecoder().decode(ServerError.self, from: data))
                ?? ServerError(error: "連線錯誤（\(status)）")
            err.status = status
            // 只有在已登入狀態下收到 401 才代表 session 失效（例如在別台裝置改了密碼）
            if status == 401, token != nil { onUnauthorized?() }
            throw err
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// 直接上傳到 R2 的預簽網址（內容已加密）。
    func put(_ url: URL, data: Data) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        let (_, resp) = try await session.upload(for: req, from: data)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw ServerError(error: "上傳失敗")
        }
    }

    func download(_ url: URL) async throws -> Data {
        let (data, resp) = try await session.data(from: url)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw ServerError(error: "下載失敗")
        }
        return data
    }
}

// MARK: - API 資料格式

struct OK: Decodable { let ok: Bool }

struct PreloginResponse: Decodable { let kdf: VaultCrypto.KDFParams }

struct LoginResponse: Decodable {
    let token: String
    let protectedVaultKey: String
    let kdf: VaultCrypto.KDFParams
    let totpEnabled: Bool
}

struct AccountResponse: Decodable {
    let email: String
    let totpEnabled: Bool
    let storageUsed: Int64
    let storageLimit: Int64
}

struct TotpSetupResponse: Decodable { let secret: String; let uri: String }

struct RecoverStartResponse: Decodable { let recoveryProtectedVaultKey: String }

struct ServerItem: Codable {
    let id: String
    let data: String
    let revision: Int
}

struct ItemsResponse: Decodable { let items: [ServerItem] }

struct ServerFile: Codable, Identifiable {
    let id: String
    let meta: String
    let chunkSizes: [Int]
    let hasThumb: Bool
    let totalSize: Int64
}

struct FilesResponse: Decodable { let files: [ServerFile] }

struct PresignedURL: Decodable { let index: Int; let url: URL }

struct URLsResponse: Decodable {
    let chunks: [PresignedURL]
    let thumb: URL?
}

extension Array where Element == UInt8 {
    var base64: String { Data(self).base64EncodedString() }
}

extension String {
    var base64Bytes: [UInt8]? { Data(base64Encoded: self).map(Array.init) }
}
