# SecureVault — 零知識加密的個人保管庫（v0.1）

存放**帳號密碼**與**照片影片**的 iPhone App。所有資料都在 iPhone 上加密後才上傳，
伺服器（Zeabur）和檔案儲存（Cloudflare R2）只保存無法解讀的密文。

```
iPhone（主密碼、金鑰、加密/解密都只在這裡）
  │  HTTPS，只傳送密文與 authKey
  ├──▶ Zeabur：Node.js API + PostgreSQL（帳號驗證、加密後的帳密項目、加密後的檔案資訊）
  └──▶ Cloudflare R2：加密後的照片/影片區塊（透過 15–60 分鐘有效的預簽網址直接上傳/下載）
```

## 安全設計

| 威脅 | 防護 |
|---|---|
| Zeabur / R2 被入侵、資料庫外洩 | 端對端加密：伺服器沒有任何解密金鑰。資料庫只有密文、`authKey` 的 Argon2id 雜湊、session token 的 SHA-256 |
| 拿到資料庫後離線暴力破解主密碼 | 主密碼經 **Argon2id（64MB 記憶體、3 次迭代）** 才產生金鑰，每猜一次都很昂貴；App 強制主密碼至少 12 字 |
| 線上猜密碼 | 每 IP 每分鐘 10 次限制、同帳號連錯 5 次鎖定 15 分鐘起（倍增，最長 24 小時）、可開啟 **TOTP 兩步驟驗證**（驗證碼不能重複使用）|
| 探測帳號是否存在 | 不存在的帳號也回傳一致的假 salt、相同錯誤訊息、相同驗證耗時 |
| 伺服器竄改、搬移、截斷密文 | XChaCha20-Poly1305 加上 AAD 綁定「用途 + ID + 區塊編號 + 是否最後一塊」，任何改動都會解密失敗 |
| 伺服器回傳較弱的加密參數 | App 拒絕低於 Argon2id 下限的參數 |
| 偷塞大檔案、灌爆容量 | 上傳網址把 Content-Length 簽進簽章；完成時伺服器逐塊核對大小；總容量與單檔上限 |
| 手機遺失或被偷 | 離開 App 立即上鎖並把金鑰從記憶體清除；Keychain 用 `ThisDeviceOnly`（不進備份）；Face ID 金鑰綁定目前登錄的臉孔；檔案全部使用 `NSFileProtectionComplete` |
| 旁人偷看 | 多工畫面、螢幕錄影、AirPlay 鏡像時遮住畫面；密碼預設隱藏；複製的密碼只留在本機剪貼簿，60 秒後清除 |
| 忘記主密碼 | 註冊時產生**復原金鑰**（請抄在紙上）。用它可以重設主密碼，同時登出所有裝置 |

### 金鑰架構

```
主密碼 ──Argon2id(salt)──▶ 主金鑰 ─┬─HKDF──▶ authKey ─▶ 伺服器（再做一次 Argon2id 才存）
                                    └─HKDF──▶ encKey ──包住──▶ vaultKey（隨機，資料金鑰）
復原金鑰（隨機 256 bit）─┬─HKDF──▶ recoveryAuthKey ─▶ 伺服器（雜湊後存）
                         └─HKDF──▶ recoveryEncKey ──包住──▶ 同一把 vaultKey

vaultKey ──▶ 加密每筆帳密項目、每個檔案的中繼資料（檔名、類型、fileKey）
fileKey（每個檔案各一把）──▶ 加密 4MB 區塊與縮圖
```

變更主密碼只需重新包住 vaultKey，不必重新加密所有資料。

## 部署後端到 Zeabur

1. **Cloudflare R2**：建立 bucket（例如 `secure-vault`，保持私有，**不要**開公開存取）。
   到「管理 R2 API 權杖」建立權杖：權限選「物件讀寫」，範圍只限這個 bucket。
2. **Zeabur**：建立專案 → 加入 **PostgreSQL** 服務 → 從 Git 部署 `server/` 資料夾（Root Directory 設為 `server`）。
3. 在服務的「環境變數」填入 [`server/.env.example`](server/.env.example) 裡的值：
   ```bash
   openssl rand -base64 32   # SERVER_SECRET
   openssl rand -hex 16      # REGISTRATION_CODE
   ```
4. 綁定網域（Zeabur 提供的 `xxx.zeabur.app` 即可，自帶 HTTPS）。打開 `https://xxx.zeabur.app/health` 應該看到 `{"ok":true}`。
5. 用 App 建立帳號後，**刪除 `REGISTRATION_CODE` 環境變數並重新部署**，註冊功能就會完全關閉。
6. 建議：在 Zeabur 開啟 PostgreSQL 自動備份；Zeabur、GitHub、Cloudflare 帳號都開啟兩步驟驗證。

## 建置 iOS App

需要 Mac + Xcode 16 以上。

```bash
brew install xcodegen
cd ios
# 編輯 project.yml：改 bundleIdPrefix 與 API_BASE_URL（你的 Zeabur 網址）
xcodegen
open SecureVault.xcodeproj
```

在 Xcode 選擇你的 Apple ID（Signing & Capabilities → Team），接上 iPhone 執行。

首次使用：建立帳號 → **抄下復原金鑰** → 登入 → 設定頁開啟 Face ID 與兩步驟驗證。

## 測試

```bash
cd server
npm install
TEST_DATABASE_URL=postgres://postgres@localhost:5432/vault_test npm test
```

測試使用與 iOS 完全相同格式的參考加密實作（`server/test/vault-crypto.js`）跑完整流程，
包括：註冊/登入、帳密加解密、多使用者隔離、分塊上傳下載影片、竄改與截斷偵測、
容量限制、兩步驟驗證與防重放、變更密碼、復原金鑰、帳號鎖定，以及**掃描整個資料庫確認找不到任何明文**。

## 目前的限制（v0.1）

- iOS 程式碼尚未在 Xcode 上編譯過（開發環境是 Linux），第一次建置可能需要修正少量編譯錯誤。
- 上傳/下載時要保持 App 在前景；離開 App 會上鎖並中斷傳輸。
- 影片要完整下載解密後才開始播放（大影片要等一下）。
- 伺服器無法讀取或偽造資料，但若被入侵，仍可能**刪除**或**回復成舊版本**的密文 → 請另外定期備份。
- 尚未實作：App 內變更主密碼、管理已登入裝置、匯出、項目離線編輯、上傳續傳、憑證綁定（certificate pinning）。
- 正式存放重要個資前，建議請資安人員做一次審查。
