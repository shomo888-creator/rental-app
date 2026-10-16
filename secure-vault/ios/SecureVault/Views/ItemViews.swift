import SwiftUI
import UniformTypeIdentifiers

struct ItemsListView: View {
    @EnvironmentObject var vault: VaultStore
    @State private var search = ""
    @State private var editing: VaultItem?

    private var filtered: [VaultItem] {
        guard !search.isEmpty else { return vault.items }
        return vault.items.filter {
            $0.name.localizedCaseInsensitiveContains(search)
                || $0.username.localizedCaseInsensitiveContains(search)
                || $0.url.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let err = vault.lastError { ErrorText(message: err) }
                ForEach(filtered) { item in
                    NavigationLink(value: item) {
                        Label {
                            VStack(alignment: .leading) {
                                Text(item.name.isEmpty ? "（未命名）" : item.name)
                                if !item.username.isEmpty {
                                    Text(item.username).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        } icon: { Image(systemName: item.kind.icon) }
                    }
                }
            }
            .overlay {
                if vault.items.isEmpty && !vault.isSyncing {
                    ContentUnavailableView("還沒有項目", systemImage: "key",
                                           description: Text("點右上角 + 新增帳號密碼或安全筆記"))
                }
            }
            .searchable(text: $search, prompt: "搜尋名稱、帳號、網址")
            .refreshable { await vault.sync() }
            .navigationTitle("密碼")
            .navigationDestination(for: VaultItem.self) { ItemDetailView(itemID: $0.id) }
            .toolbar {
                Button { editing = VaultItem() } label: { Image(systemName: "plus") }
            }
            .sheet(item: $editing) { ItemEditView(item: $0) }
        }
    }
}

struct ItemDetailView: View {
    @EnvironmentObject var vault: VaultStore
    @Environment(\.dismiss) var dismiss
    let itemID: String
    @State private var revealed = false
    @State private var editing: VaultItem?
    @State private var confirmDelete = false
    @State private var copied: String?
    @State private var error: String?

    private var item: VaultItem? { vault.items.first { $0.id == itemID } }

    var body: some View {
        Form {
            if let item {
                if item.kind == .login {
                    Section {
                        row("帳號", item.username)
                        HStack {
                            VStack(alignment: .leading) {
                                Text("密碼").font(.caption).foregroundStyle(.secondary)
                                Text(revealed ? item.password : String(repeating: "•", count: 10))
                                    .font(.system(.body, design: .monospaced))
                                    .privacySensitive()
                            }
                            Spacer()
                            Button { revealed.toggle() } label: {
                                Image(systemName: revealed ? "eye.slash" : "eye")
                            }.buttonStyle(.borderless)
                            Button { copy(item.password, "密碼") } label: {
                                Image(systemName: "doc.on.doc")
                            }.buttonStyle(.borderless)
                        }
                        if !item.url.isEmpty {
                            row("網址", item.url)
                        }
                    }
                }
                if !item.notes.isEmpty {
                    Section("筆記") { Text(item.notes).privacySensitive() }
                }
                if let copied {
                    Text("已複製\(copied)，60 秒後會自動從剪貼簿清除").font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button("刪除", role: .destructive) { confirmDelete = true }
                    ErrorText(message: error)
                }
            }
        }
        .navigationTitle(item?.name ?? "")
        .toolbar { Button("編輯") { editing = item } }
        .sheet(item: $editing) { ItemEditView(item: $0) }
        .confirmationDialog("確定要刪除？刪除後無法復原。", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("刪除", role: .destructive) {
                Task {
                    guard let item else { return }
                    do { try await vault.delete(item); dismiss() } catch { self.error = error.localizedDescription }
                }
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            VStack(alignment: .leading) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Text(value).privacySensitive()
            }
            Spacer()
            Button { copy(value, label) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.borderless)
        }
    }

    /// 只複製到本機剪貼簿（不經「通用剪貼板」傳到其他裝置），60 秒後自動清除。
    private func copy(_ value: String, _ label: String) {
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: value]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(60)])
        copied = label
    }
}

struct ItemEditView: View {
    @EnvironmentObject var vault: VaultStore
    @Environment(\.dismiss) var dismiss
    @State var item: VaultItem
    @State private var showPassword = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Picker("類型", selection: $item.kind) {
                    ForEach(VaultItem.Kind.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                Section {
                    TextField("名稱（例如：玉山銀行）", text: $item.name)
                    if item.kind == .login {
                        TextField("帳號", text: $item.username)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        HStack {
                            Group {
                                if showPassword { TextField("密碼", text: $item.password) }
                                else { SecureField("密碼", text: $item.password) }
                            }
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .font(.system(.body, design: .monospaced))
                            Button { showPassword.toggle() } label: {
                                Image(systemName: showPassword ? "eye.slash" : "eye")
                            }.buttonStyle(.borderless)
                        }
                        Button("產生高強度密碼") {
                            item.password = PasswordGenerator.generate()
                            showPassword = true
                        }
                        TextField("網址", text: $item.url)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }
                Section("筆記") {
                    TextField("例如：安全提問答案、PIN 碼", text: $item.notes, axis: .vertical).lineLimit(3...10)
                }
                ErrorText(message: error)
            }
            .navigationTitle(item.revision == 0 ? "新增" : "編輯")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "儲存中…" : "儲存") { Task { await save() } }
                        .disabled(busy || item.name.isEmpty)
                }
            }
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        do {
            try await vault.save(item)
            dismiss()
        } catch let e as APIClient.ServerError where e.status == 409 {
            error = "這個項目已在其他裝置被修改。請關閉後重新整理再編輯。"
        } catch {
            self.error = error.localizedDescription
        }
    }
}
