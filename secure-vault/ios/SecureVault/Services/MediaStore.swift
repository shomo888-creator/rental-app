import Foundation
import UIKit
import AVFoundation
import ImageIO
import UniformTypeIdentifiers
import CoreTransferable

/// 照片與影片：在手機上切塊加密後直接上傳到 R2，下載時在手機上解密。
@MainActor
final class MediaStore: ObservableObject {
    struct Upload: Identifiable {
        let id = UUID()
        let name: String
        var progress: Double = 0
        var error: String?
    }

    @Published private(set) var files: [MediaFile] = []
    @Published private(set) var thumbnails: [String: UIImage] = [:]
    @Published var uploads: [Upload] = []
    @Published var lastError: String?

    private unowned let app: AppState
    private static let urlBatch = 100

    init(app: AppState) { self.app = app }

    func clear() {
        files = []
        thumbnails = [:]
    }

    func load() async {
        guard let key = app.vaultKey else { return }
        do {
            let res: FilesResponse = try await app.api.send("GET", "api/files")
            files = res.files.compactMap { f in
                guard let sealed = f.meta.base64Bytes,
                      let plain = try? VaultCrypto.open(sealed, key: key, aad: VaultCrypto.AAD.fileMeta(f.id)),
                      let meta = try? JSONDecoder().decode(FileMeta.self, from: Data(plain))
                else { return nil }
                return MediaFile(id: f.id, meta: meta, chunkSizes: f.chunkSizes, hasThumb: f.hasThumb)
            }
            .sorted { $0.meta.createdAt > $1.meta.createdAt }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - 縮圖

    func loadThumbnail(_ file: MediaFile) async {
        guard file.hasThumb, thumbnails[file.id] == nil, let fileKey = file.meta.fileKey.base64Bytes else { return }
        do {
            let urls = try await downloadURLs(file, chunks: [], thumb: true)
            guard let url = urls.thumb else { return }
            let sealed = try await app.api.download(url)
            let plain = try VaultCrypto.open(Array(sealed), key: fileKey, aad: VaultCrypto.AAD.thumb(file.id))
            thumbnails[file.id] = UIImage(data: Data(plain))
        } catch {}
    }

    // MARK: - 開啟（解密到暫存檔，上鎖時刪除）

    func decryptToTempFile(_ file: MediaFile) async throws -> URL {
        guard let fileKey = file.meta.fileKey.base64Bytes else { throw VaultError.crypto }
        let ext = (file.meta.name as NSString).pathExtension
        let out = TempFiles.newURL(ext: ext.isEmpty ? "bin" : ext)
        FileManager.default.createFile(atPath: out.path, contents: nil,
                                       attributes: [.protectionKey: FileProtectionType.complete])
        let handle = try FileHandle(forWritingTo: out)
        defer { try? handle.close() }

        let count = file.chunkSizes.count
        for start in stride(from: 0, to: count, by: Self.urlBatch) {
            let indices = Array(start..<min(start + Self.urlBatch, count))
            let urls = try await downloadURLs(file, chunks: indices, thumb: false)
            for u in urls.chunks.sorted(by: { $0.index < $1.index }) {
                let sealed = try await app.api.download(u.url)
                // AAD 含區塊編號與「是否最後一塊」：順序被調換或檔案被截斷都會解密失敗
                let plain = try VaultCrypto.open(
                    Array(sealed), key: fileKey,
                    aad: VaultCrypto.AAD.chunk(file.id, u.index, last: u.index == count - 1))
                try handle.write(contentsOf: plain)
            }
        }
        return out
    }

    private func downloadURLs(_ file: MediaFile, chunks: [Int], thumb: Bool) async throws -> URLsResponse {
        struct Body: Encodable { let chunks: [Int]; let thumb: Bool }
        return try await app.api.send("POST", "api/files/\(file.id)/download-urls",
                                      body: Body(chunks: chunks, thumb: thumb))
    }

    func delete(_ file: MediaFile) async throws {
        let _: OK = try await app.api.send("DELETE", "api/files/\(file.id)")
        thumbnails[file.id] = nil
        await load()
    }

    // MARK: - 上傳

    func upload(_ picked: PickedMedia) async {
        let name = picked.url.lastPathComponent
        uploads.append(Upload(name: name))
        let uploadID = uploads.last!.id
        // 不論成功或失敗，都刪除未加密的暫存副本
        defer { try? FileManager.default.removeItem(at: picked.url.deletingLastPathComponent()) }
        do {
            try await encryptAndUpload(picked.url, name: name) { [weak self] p in
                guard let self, let i = self.uploads.firstIndex(where: { $0.id == uploadID }) else { return }
                self.uploads[i].progress = p
            }
            uploads.removeAll { $0.id == uploadID }
            await load()
        } catch {
            if let i = uploads.firstIndex(where: { $0.id == uploadID }) {
                uploads[i].error = error.localizedDescription
            }
        }
    }

    private func encryptAndUpload(_ url: URL, name: String, progress: @escaping (Double) -> Void) async throws {
        guard let vaultKey = app.vaultKey else { throw VaultError.crypto }
        let id = UUID().uuidString.lowercased()
        let type = UTType(filenameExtension: url.pathExtension) ?? .data
        let kind: FileMeta.Kind = type.conforms(to: .movie) ? .video : type.conforms(to: .image) ? .image : .other
        let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        let sizes = VaultCrypto.sealedChunkSizes(fileSize: size)
        let count = sizes.count

        // 每個檔案都有自己的隨機金鑰
        var fileKey = VaultCrypto.randomKey()
        defer { VaultCrypto.wipe(&fileKey) }

        let thumbSealed = try await Self.thumbnailJPEG(url, kind: kind).map {
            try VaultCrypto.seal(Array($0), key: fileKey, aad: VaultCrypto.AAD.thumb(id))
        }
        let meta = FileMeta(name: name, mime: type.preferredMIMEType ?? "application/octet-stream",
                            kind: kind, size: size, chunkCount: count, fileKey: fileKey.base64,
                            createdAt: Date())
        let sealedMeta = try VaultCrypto.seal(Array(try JSONEncoder().encode(meta)), key: vaultKey,
                                              aad: VaultCrypto.AAD.fileMeta(id))

        struct Create: Encodable { let id, meta: String; let chunkSizes: [Int]; let thumbSize: Int? }
        struct Created: Decodable { let id: String }
        let _: Created = try await app.api.send("POST", "api/files", body: Create(
            id: id, meta: sealedMeta.base64, chunkSizes: sizes, thumbSize: thumbSealed?.count))

        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        struct URLReq: Encodable { let chunks: [Int]; let thumb: Bool }

        for start in stride(from: 0, to: count, by: Self.urlBatch) {
            let indices = Array(start..<min(start + Self.urlBatch, count))
            let urls: URLsResponse = try await app.api.send(
                "POST", "api/files/\(id)/upload-urls",
                body: URLReq(chunks: indices, thumb: start == 0 && thumbSealed != nil))
            if let t = urls.thumb, let thumbSealed { try await app.api.put(t, data: Data(thumbSealed)) }

            for u in urls.chunks.sorted(by: { $0.index < $1.index }) {
                try handle.seek(toOffset: UInt64(u.index * VaultCrypto.chunkSize))
                let plain = try handle.read(upToCount: VaultCrypto.chunkSize) ?? Data()
                let sealed = try VaultCrypto.seal(
                    Array(plain), key: fileKey,
                    aad: VaultCrypto.AAD.chunk(id, u.index, last: u.index == count - 1))
                try await app.api.put(u.url, data: Data(sealed))
                progress(Double(u.index + 1) / Double(count))
            }
        }
        let _: ServerFile = try await app.api.send("POST", "api/files/\(id)/complete")
    }

    /// 400px 縮圖，與原檔一起加密上傳，讓相簿列表不必下載整個檔案。
    private static func thumbnailJPEG(_ url: URL, kind: FileMeta.Kind) async throws -> Data? {
        switch kind {
        case .image:
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                      kCGImageSourceThumbnailMaxPixelSize: 400,
                  ] as CFDictionary)
            else { return nil }
            return UIImage(cgImage: cg).jpegData(compressionQuality: 0.7)
        case .video:
            let gen = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            gen.appliesPreferredTrackTransform = true
            gen.maximumSize = CGSize(width: 400, height: 400)
            guard let frame = try? await gen.image(at: .zero) else { return nil }
            return UIImage(cgImage: frame.image).jpegData(compressionQuality: 0.7)
        case .other:
            return nil
        }
    }
}

/// 從相簿選取的檔案先複製到受保護的暫存區，加密上傳後立即刪除。
struct PickedMedia: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { try copy($0.file) }
        FileRepresentation(importedContentType: .image) { try copy($0.file) }
    }

    private static func copy(_ src: URL) throws -> PickedMedia {
        let dst = TempFiles.dir.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dst, withIntermediateDirectories: true,
                                                attributes: [.protectionKey: FileProtectionType.complete])
        let file = dst.appendingPathComponent(src.lastPathComponent)
        try FileManager.default.copyItem(at: src, to: file)
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
        return PickedMedia(url: file)
    }
}
