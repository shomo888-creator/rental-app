import SwiftUI
import LocalAuthentication

private let minPasswordLength = 12

struct LoginView: View {
    @EnvironmentObject var app: AppState
    @State private var email = ""
    @State private var password = ""
    @State private var totp = ""
    @State private var needsTotp = false
    @State private var busy = false
    @State private var error: String?
    @State private var showRegister = false
    @State private var showRecover = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email", text: $email)
                        .textContentType(.username).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("主密碼", text: $password).textContentType(.password)
                    if needsTotp {
                        TextField("兩步驟驗證碼（6 位數）", text: $totp)
                            .keyboardType(.numberPad).textContentType(.oneTimeCode)
                    }
                } footer: {
                    Text("主密碼不會傳送到伺服器。忘記主密碼又沒有復原金鑰時，任何人（包括開發者）都無法救回資料。")
                }
                Section {
                    Button(busy ? "登入中…" : "登入") { Task { await login() } }
                        .disabled(busy || email.isEmpty || password.isEmpty)
                    ErrorText(message: error)
                }
                Section {
                    Button("建立新帳號") { showRegister = true }
                    Button("忘記主密碼？使用復原金鑰") { showRecover = true }
                }
            }
            .navigationTitle("SecureVault")
            .sheet(isPresented: $showRegister) { RegisterView() }
            .sheet(isPresented: $showRecover) { RecoverView() }
        }
    }

    private func login() async {
        busy = true
        defer { busy = false }
        do {
            let r = try await app.login(email: email, password: password, totp: needsTotp ? totp : nil)
            if r == .needsTotp {
                needsTotp = true
                error = "請輸入驗證器 App 中的 6 位數驗證碼"
            } else {
                password = ""
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct RegisterView: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) var dismiss
    @State private var email = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?
    @State private var recoveryKey: String?

    var body: some View {
        NavigationStack {
            if let recoveryKey {
                RecoveryKeyView(recoveryKey: recoveryKey) { dismiss() }
            } else {
                Form {
                    Section {
                        TextField("Email", text: $email)
                            .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("主密碼（至少 \(minPasswordLength) 個字）", text: $password).textContentType(.newPassword)
                        SecureField("再輸入一次主密碼", text: $confirm).textContentType(.newPassword)
                    } footer: {
                        Text("建議用一句好記的長句子，例如「我家的貓每天早上七點叫我起床」。")
                    }
                    Section {
                        SecureField("註冊碼（伺服器的 REGISTRATION_CODE）", text: $code)
                    }
                    Section {
                        Button(busy ? "建立中…" : "建立帳號") { Task { await register() } }
                            .disabled(busy || !valid)
                        ErrorText(message: error)
                    }
                }
                .navigationTitle("建立帳號")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            }
        }
        .interactiveDismissDisabled(recoveryKey != nil)
    }

    private var valid: Bool {
        email.contains("@") && password.count >= minPasswordLength && password == confirm && !code.isEmpty
    }

    private func register() async {
        busy = true
        defer { busy = false }
        do {
            recoveryKey = try await app.register(email: email, password: password, registrationCode: code)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct RecoveryKeyView: View {
    let recoveryKey: String
    let done: () -> Void
    @State private var saved = false

    var body: some View {
        Form {
            Section {
                Text(recoveryKey)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.disabled)
                    .padding(.vertical, 8)
            } header: {
                Text("你的復原金鑰")
            } footer: {
                Text("""
                請用紙筆抄下來，收在安全的地方（不要截圖、不要存在手機或雲端）。
                忘記主密碼時，這是唯一能救回資料的方法。這組金鑰只會顯示這一次。
                """)
            }
            Section {
                Toggle("我已經抄寫並妥善保存", isOn: $saved)
                Button("完成，前往登入", action: done).disabled(!saved)
            }
        }
        .navigationTitle("復原金鑰")
        .navigationBarBackButtonHidden()
    }
}

struct RecoverView: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) var dismiss
    @State private var email = ""
    @State private var key = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var error: String?
    @State private var done = false

    var body: some View {
        NavigationStack {
            Form {
                if done {
                    Section {
                        Text("主密碼已重設，所有裝置都已登出，兩步驟驗證也已關閉。請用新密碼登入，並重新開啟兩步驟驗證。")
                        Button("完成") { dismiss() }
                    }
                } else {
                    Section {
                        TextField("Email", text: $email)
                            .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("復原金鑰 XXXX-XXXX-…", text: $key, axis: .vertical)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled()
                            .font(.system(.body, design: .monospaced))
                    }
                    Section {
                        SecureField("新的主密碼（至少 \(minPasswordLength) 個字）", text: $password)
                        SecureField("再輸入一次", text: $confirm)
                    }
                    Section {
                        Button(busy ? "處理中…" : "重設主密碼") { Task { await recover() } }
                            .disabled(busy || password.count < minPasswordLength || password != confirm)
                        ErrorText(message: error)
                    }
                }
            }
            .navigationTitle("使用復原金鑰")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        }
    }

    private func recover() async {
        busy = true
        defer { busy = false }
        do {
            try await app.recover(email: email, recoveryKey: key, newPassword: password)
            done = true
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct UnlockView: View {
    @EnvironmentObject var app: AppState
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(app.storedAccount?.email ?? "", systemImage: "person.crop.circle")
                    SecureField("主密碼", text: $password).textContentType(.password)
                        .onSubmit { Task { await unlock() } }
                    Button(busy ? "解鎖中…" : "用主密碼解鎖") { Task { await unlock() } }
                        .disabled(busy || password.isEmpty)
                    if app.biometricsEnabled {
                        Button { Task { await biometric() } } label: {
                            Label("使用 Face ID 解鎖", systemImage: "faceid")
                        }
                    }
                    ErrorText(message: error)
                }
                Section {
                    Button("登出", role: .destructive) { Task { await app.logout() } }
                }
            }
            .navigationTitle("已上鎖")
            .task { if app.biometricsEnabled { await biometric() } }
        }
    }

    private func unlock() async {
        busy = true
        defer { busy = false }
        do {
            try await app.unlock(password: password)
            password = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func biometric() async {
        do {
            try await app.unlockWithBiometrics()
        } catch KeychainError.status(errSecUserCanceled) {
        } catch KeychainError.status(errSecItemNotFound) {
            // 新增/移除了 Face ID 臉孔，金鑰已失效
            try? app.setBiometrics(enabled: false)
            error = "Face ID 設定已變更，請輸入主密碼後重新開啟 Face ID"
        } catch {
            self.error = error.localizedDescription
        }
    }
}
