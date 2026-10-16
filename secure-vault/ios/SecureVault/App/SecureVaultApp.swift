import SwiftUI

@main
struct SecureVaultApp: App {
    @StateObject private var app = AppState()
    @Environment(\.scenePhase) private var scenePhase
    @State private var screenCaptured = UIScreen.main.isCaptured

    var body: some Scene {
        WindowGroup {
            ZStack {
                RootView()
                    .environmentObject(app)
                    .environmentObject(app.vault)
                    .environmentObject(app.media)
                // 切到多工畫面或被錄影/投影時遮住內容
                if scenePhase != .active || (screenCaptured && app.phase == .unlocked) {
                    PrivacyCover(captured: screenCaptured)
                }
            }
            .onChange(of: scenePhase) { _, phase in
                // 離開 App 立即上鎖，金鑰從記憶體清除
                if phase == .background { app.lock() }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)) { _ in
                screenCaptured = UIScreen.main.isCaptured
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        switch app.phase {
        case .loggedOut: LoginView()
        case .locked: UnlockView()
        case .unlocked: MainView()
        }
    }
}

struct PrivacyCover: View {
    let captured: Bool
    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            VStack(spacing: 12) {
                Image(systemName: "lock.shield.fill").font(.system(size: 56)).foregroundStyle(.tint)
                Text(captured ? "偵測到螢幕錄影或鏡像，內容已隱藏" : "SecureVault")
                    .font(.headline)
            }
        }
    }
}

struct MainView: View {
    var body: some View {
        TabView {
            ItemsListView().tabItem { Label("密碼", systemImage: "key.fill") }
            MediaGridView().tabItem { Label("相簿", systemImage: "photo.on.rectangle") }
            SettingsView().tabItem { Label("設定", systemImage: "gearshape") }
        }
    }
}

/// 共用：執行非同步動作並顯示錯誤
struct ErrorText: View {
    let message: String?
    var body: some View {
        if let message { Text(message).foregroundStyle(.red).font(.footnote) }
    }
}
