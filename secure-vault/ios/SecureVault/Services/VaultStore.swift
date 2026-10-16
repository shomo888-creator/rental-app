import Foundation

/// 帳密項目：從伺服器同步密文，在手機上解密後顯示。
/// 密文也會快取在手機上（受 iOS 資料保護加密），沒有網路時仍可查閱。
@MainActor
final class VaultStore: ObservableObject {
    @Published private(set) var items: [VaultItem] = []
    @Published private(set) var isSyncing = false
    @Published var lastError: String?

    private unowned let app: AppState

    init(app: AppState) { self.app = app }

    private static var cacheURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("items.cache.json")
    }

    static func deleteCache() {
        try? FileManager.default.removeItem(at: cacheURL)
    }

    func clear() { items = [] }

    func load() async {
        if let data = try? Data(contentsOf: Self.cacheURL),
           let cached = try? JSONDecoder().decode([ServerItem].self, from: data) {
            items = decrypt(cached)
        }
        await sync()
    }

    func sync() async {
        isSyncing = true
        defer { isSyncing = false }
        do {
            let res: ItemsResponse = try await app.api.send("GET", "api/items")
            var url = Self.cacheURL
            try JSONEncoder().encode(res.items).write(to: url, options: [.completeFileProtection, .atomic])
            var values = URLResourceValues()
            values.isExcludedFromBackup = true // 不進 iCloud 備份
            try? url.setResourceValues(values)
            items = decrypt(res.items)
            lastError = nil
        } catch {
            lastError = "無法同步（目前顯示離線資料）：\(error.localizedDescription)"
        }
    }

    private func decrypt(_ server: [ServerItem]) -> [VaultItem] {
        guard let key = app.vaultKey else { return [] }
        return server.compactMap { s in
            guard let sealed = s.data.base64Bytes,
                  let plain = try? VaultCrypto.open(sealed, key: key, aad: VaultCrypto.AAD.item(s.id)),
                  var item = try? JSONDecoder().decode(VaultItem.self, from: Data(plain))
            else { return nil } // 解不開的密文（被竄改）直接忽略
            item.id = s.id
            item.revision = s.revision
            return item
        }
        .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    func save(_ item: VaultItem) async throws {
        guard let key = app.vaultKey else { return }
        var item = item
        item.updatedAt = Date()
        let plain = Array(try JSONEncoder().encode(item))
        let sealed = try VaultCrypto.seal(plain, key: key, aad: VaultCrypto.AAD.item(item.id))

        struct Body: Encodable { let data: String; let revision: Int }
        let _: ServerItem = try await app.api.send(
            "PUT", "api/items/\(item.id)", body: Body(data: sealed.base64, revision: item.revision))
        await sync()
    }

    func delete(_ item: VaultItem) async throws {
        let _: OK = try await app.api.send("DELETE", "api/items/\(item.id)")
        await sync()
    }
}
