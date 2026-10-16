import SwiftUI
import PhotosUI
import AVKit

struct MediaGridView: View {
    @EnvironmentObject var media: MediaStore
    @State private var picks: [PhotosPickerItem] = []
    @State private var viewing: MediaFile?

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 2)]

    var body: some View {
        NavigationStack {
            ScrollView {
                if !media.uploads.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(media.uploads) { u in
                            VStack(alignment: .leading) {
                                Text("加密上傳中：\(u.name)").font(.caption)
                                if let err = u.error { ErrorText(message: err) }
                                else { ProgressView(value: u.progress) }
                            }
                        }
                        Text("上傳期間請保持 App 開啟；離開 App 會自動上鎖並中斷上傳。")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding()
                }
                if let err = media.lastError { ErrorText(message: err).padding() }
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(media.files) { file in
                        Button { viewing = file } label: { Thumbnail(file: file) }
                    }
                }
            }
            .overlay {
                if media.files.isEmpty && media.uploads.isEmpty {
                    ContentUnavailableView("還沒有照片或影片", systemImage: "photo",
                                           description: Text("點右上角從相簿選取，會在手機上加密後才上傳"))
                }
            }
            .refreshable { await media.load() }
            .navigationTitle("相簿")
            .toolbar {
                PhotosPicker(selection: $picks, maxSelectionCount: 20, matching: .any(of: [.images, .videos])) {
                    Image(systemName: "plus")
                }
            }
            .onChange(of: picks) { _, items in
                guard !items.isEmpty else { return }
                picks = []
                Task {
                    for item in items {
                        do {
                            if let picked = try await item.loadTransferable(type: PickedMedia.self) {
                                await media.upload(picked)
                            }
                        } catch {
                            media.lastError = "無法讀取所選檔案：\(error.localizedDescription)"
                        }
                    }
                }
            }
            .fullScreenCover(item: $viewing) { MediaViewer(file: $0) }
        }
    }
}

struct Thumbnail: View {
    @EnvironmentObject var media: MediaStore
    let file: MediaFile

    var body: some View {
        Color(.secondarySystemBackground)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let img = media.thumbnails[file.id] {
                    Image(uiImage: img).resizable().scaledToFill()
                } else {
                    Image(systemName: file.meta.kind == .video ? "video" : "photo").foregroundStyle(.secondary)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if file.meta.kind == .video {
                    Image(systemName: "play.circle.fill").foregroundStyle(.white).shadow(radius: 2).padding(4)
                }
            }
            .clipped()
            .task { await media.loadThumbnail(file) }
    }
}

struct MediaViewer: View {
    @EnvironmentObject var media: MediaStore
    @Environment(\.dismiss) var dismiss
    let file: MediaFile
    @State private var localURL: URL?
    @State private var player: AVPlayer?
    @State private var error: String?
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let error {
                    ErrorText(message: error)
                } else if let player {
                    VideoPlayer(player: player)
                } else if let localURL, let img = UIImage(contentsOfFile: localURL.path) {
                    Image(uiImage: img).resizable().scaledToFit()
                } else {
                    VStack {
                        ProgressView().tint(.white)
                        Text("下載並解密中…").foregroundStyle(.white).font(.caption)
                    }
                }
            }
            .navigationTitle(file.meta.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("關閉") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) {
                    Button(role: .destructive) { confirmDelete = true } label: { Image(systemName: "trash") }
                }
            }
            .confirmationDialog("確定要永久刪除？", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("刪除", role: .destructive) {
                    Task {
                        do { try await media.delete(file); dismiss() }
                        catch { self.error = error.localizedDescription }
                    }
                }
            }
        }
        .task {
            do {
                let url = try await media.decryptToTempFile(file)
                localURL = url
                if file.meta.kind == .video { player = AVPlayer(url: url) }
            } catch {
                self.error = "無法開啟：\(error.localizedDescription)"
            }
        }
        .onDisappear {
            // 關閉時立刻刪除解密後的暫存檔
            player?.pause()
            if let localURL { try? FileManager.default.removeItem(at: localURL) }
        }
    }
}
