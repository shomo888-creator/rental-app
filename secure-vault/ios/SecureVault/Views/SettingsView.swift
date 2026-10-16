import SwiftUI
import CoreImage.CIFilterBuiltins

struct SettingsView: View {
    @EnvironmentObject var app: AppState
    @State private var account: AccountResponse?
    @State private var error: String?
    @State private var showTotp = false
    @State private var confirmLogoutAll = false

    var body: some View {
        NavigationStack {
            Form {
                if let account {
                    Section("帳號") {
                        LabeledContent("Email", value: account.email)
                        LabeledContent("已使用空間") {
                            Text("\(bytes(account.storageUsed)) / \(bytes(account.storageLimit))")
                        }
                    }
                }
                Section {
                    Toggle("使用 Face ID 解鎖", isOn: Binding(
                        get: { app.biometricsEnabled },
                        set: { on in
                            do { try app.setBiometrics(enabled: on) } catch { self.error = error.localizedDescription }
                        }))
                    if account?.totpEnabled == true {
                        Label("兩步驟驗證已開啟", systemImage: "checkmark.shield.fill").foregroundStyle(.green)
                    } else {
                        Button("開啟兩步驟驗證（強烈建議）") { showTotp = true }
                    }
                } header: {
                    Text("安全性")
                } footer: {
                    Text("Face ID 的金鑰存在這支手機的 Secure Enclave，新增或移除臉孔後會自動失效。")
                }
                Section {
                    Button("立即上鎖") { app.lock() }
                    Button("登出") { Task { await app.logout() } }
                    Button("登出所有裝置", role: .destructive) { confirmLogoutAll = true }
                    ErrorText(message: error)
                }
            }
            .navigationTitle("設定")
            .task { await reload() }
            .sheet(isPresented: $showTotp, onDismiss: { Task { await reload() } }) { TotpSetupView() }
            .confirmationDialog("所有裝置（包括這台）都會被登出", isPresented: $confirmLogoutAll,
                                titleVisibility: .visible) {
                Button("登出所有裝置", role: .destructive) { Task { await app.logout(allDevices: true) } }
            }
        }
    }

    private func reload() async {
        do { account = try await app.api.send("GET", "api/account", as: AccountResponse.self) }
        catch { self.error = error.localizedDescription }
    }

    private func bytes(_ n: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: n, countStyle: .file)
    }
}

struct TotpSetupView: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) var dismiss
    @State private var password = ""
    @State private var setup: TotpSetupResponse?
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let setup {
                    Section {
                        if let qr = qrImage(setup.uri) {
                            Image(uiImage: qr).interpolation(.none).resizable().scaledToFit()
                                .frame(maxWidth: 220).frame(maxWidth: .infinity)
                        }
                        Text(setup.secret).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                    } footer: {
                        Text("用「另一支裝置」上的驗證器 App（如 Google Authenticator、Microsoft Authenticator）掃描，或手動輸入上方密鑰。")
                    }
                    Section {
                        TextField("輸入驗證器顯示的 6 位數", text: $code).keyboardType(.numberPad)
                        Button(busy ? "驗證中…" : "啟用") { Task { await enable() } }
                            .disabled(busy || code.count != 6)
                    }
                } else {
                    Section {
                        SecureField("請再輸入一次主密碼", text: $password)
                        Button(busy ? "處理中…" : "下一步") { Task { await start() } }
                            .disabled(busy || password.isEmpty)
                    }
                }
                ErrorText(message: error)
            }
            .navigationTitle("兩步驟驗證")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        }
    }

    private func start() async {
        busy = true
        defer { busy = false }
        do {
            struct Body: Encodable { let authKey: String }
            let key = try await app.authKey(password: password)
            setup = try await app.api.send("POST", "api/auth/totp/setup", body: Body(authKey: key), as: TotpSetupResponse.self)
            password = ""
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func enable() async {
        busy = true
        defer { busy = false }
        do {
            struct Body: Encodable { let code: String }
            let _: OK = try await app.api.send("POST", "api/auth/totp/enable", body: Body(code: code))
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func qrImage(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        guard let out = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
