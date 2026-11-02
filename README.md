# 🎲 Discord VC Team Splitter (クラウド無料枠完結 ＆ ワンクリック導入対応)

Discordのボイスチャンネル（VC）に入っているメンバーを**自動認識**し、
「**7人VCにいる時に、5人Valorantフルパ＋残り2人を抽選する**」といった**優先人数指定**や、**グループ数指定（均等割り）**、**観戦・除外設定**、**再抽選**、**「別のVCチャンネルへ移動しますか？」の確認ポップアップからの自動VC移動**まで対応したDiscordアプリ（Bot ＋ Web UI）です。

自分のPCでNode.jsを動かさなくても、**無料クラウド（Render.com や Koyeb の Free プラン）上で24時間完結**し、公開されている普通のDiscord Botと同じように **「招待リンクから好きなDiscordサーバーに導入するだけ」** で使えます。

---

## 🌟 普通のDiscordアプリと同じように導入する仕組み

このアプリには以下のクラウド＆マルチサーバー対応が組み込まれています：
1. **ワンクリック導入リンク (`/invite` ＆ Web UI右上の「➕ Discordサーバーに導入する」ボタン)**
   - 必要な権限（VCメンバー自動認識・メッセージ送信・スラッシュコマンド・別VCへの移動）がすべて自動セットされた公式OAuth2認証画面が開き、**ドロップダウンでサーバーを選んで「認証」を押すだけ**で導入が完了します。
2. **導入した瞬間に `/team` コマンドが即時有効化 (`guildCreate` 自動検知)**
   - 新しいDiscordサーバーにこのBotが追加された瞬間、自動でそのサーバーに `/team` コマンドを即時登録するため、待ち時間ゼロですぐに使えます。
3. **無料クラウドのヘルスチェック＆スリープ防止 (`/healthz` + GitHub Actions)**
   - [render.yaml](file:///C:/Users/haxai/.gemini/antigravity/scratch/discord-vc-team-splitter/render.yaml)、[Dockerfile](file:///C:/Users/haxai/.gemini/antigravity/scratch/discord-vc-team-splitter/Dockerfile)、[.github/workflows/keep-alive.yml](file:///C:/Users/haxai/.gemini/antigravity/scratch/discord-vc-team-splitter/.github/workflows/keep-alive.yml) を同梱しています。

---

## ☁️ 完全無料でクラウド上で完結させる手順（PCへのインストール不要）

### ステップ1：Discord Developer Portal で Bot トークンを取得（約2分）
1. [Discord Developer Portal](https://discord.com/developers/applications) を開き、右上の **「New Application」** からアプリを作成します。
2. **「General Information」** ページにある **Application ID**（数字の羅列）をコピーして控えます。
3. 左メニュー **「Bot」** を開き、**「Reset Token」** を押して表示される **Token** をコピーして控えます。
4. 同じ **「Bot」** ページを下にスクロールし、**Privileged Gateway Intents** の **「SERVER MEMBERS INTENT」** を **ON（緑）** にして **Save Changes** を押します。

---

### ステップ2：GitHub にアップロードして Render.com（無料枠）で公開（約3分）

1. このフォルダ（`discord-vc-team-splitter`）の中身をあなたの GitHub リポジトリにアップロード（Push またはブラウザからドラッグ＆ドロップで Upload files）します。
2. 無料クラウドの **[Render.com](https://render.com/)**（または **[Koyeb](https://www.koyeb.com/)**）にGitHubアカウントでログインします。
3. Render のダッシュボードで **「New +」 ➔ 「Blueprint」**（または **「Web Service」**）を選択し、先ほどのGitHubリポジトリを選びます。
   - **Plan**: `Free`（無料・クレジットカード不要）を選択
   - **Environment Variables（環境変数）** にステップ1で控えた2つを入力します：
     - `DISCORD_TOKEN`: 控えた Bot Token
     - `DISCORD_CLIENT_ID`: 控えた Application ID
4. **「Create Web Service / Apply」** を押すと自動でビルド＆起動が完了し、`https://xxxx.onrender.com` のようなあなた専用の公開URLが発行されます！

> 💡 **無料枠のスリープ防止（任意）**
> GitHub リポジトリの **Settings ➔ Secrets and variables ➔ Actions ➔ Variables** タブで、New repository variable として名前 `APP_URL`・値 `https://xxxx.onrender.com` を登録しておくと、同梱の [.github/workflows/keep-alive.yml](file:///C:/Users/haxai/.gemini/antigravity/scratch/discord-vc-team-splitter/.github/workflows/keep-alive.yml) が10分おきに `/healthz` を自動巡回してスリープを防ぎます。

---

### ステップ3：普通のDiscordアプリと同じようにサーバーへ導入する！

クラウド起動後、以下のいずれかの方法で自分のDiscordサーバー（または友達のサーバー）にいつでも導入できます：

- **方法A（Web UIからワンクリック）**:
  発行されたクラウドURL（`https://xxxx.onrender.com`）を開き、画面右上の **「➕ Discordサーバーに導入する」** ボタンを押す
- **方法B（招待専用URLを直接開く・共有する）**:
  `https://xxxx.onrender.com/invite` にアクセスする（友達にこのURLを送れば、友達のサーバーにもそのまま導入できます）

Discordの公式認証画面が開くので、追加したいサーバーを選んで **「認証」** を押すだけで導入完了です！

---

## 🎮 導入後の使い方

### 1. Discord チャット上で使う（スラッシュコマンド `/team`）
ボイスチャンネルに入った状態で、チャット欄に `/team` と打って実行するだけです！
- **初期設定（引数なし）**: 自動的にあなたが入っているVCのメンバーを認識し、**「Valorant 5人フルパ優先 ＋ 残りメンバー抽選」** を行います（7人なら5人＋2人）。
- 表示された結果パネルの下にあるメニュー＆ボタンから、誰でもその場で操作できます：
  - **⚙️ 抽選ルール変更メニュー**: Valorant 5人優先 / 1組だけ5人抽選 / 5v5カスタム / Apex 3人優先 / 4人優先 / 2人優先 / 2〜3グループ均等分け
  - **👀 除外メンバー選択メニュー**: 観戦や離席の人を選ぶとその人を除いて即再計算
  - **🔄 再抽選ボタン**: ワンクリックでシャッフルやり直し
  - **🔊 別のVCへ移動...ボタン**: *「別のVCチャンネルへ移動しますか？」* の確認ポップアップが表示され、各チームの移動先VCを選んで **「✅ 移動を実行する」** を押すと全員が各VCへ自動移動します！
  - **🌐 Web UIで開くボタン**: クラウド上のリッチWeb UIが、現在のサーバー＆VCが選択された状態で開きます。

### 2. 本格 Web UI で使う
クラウドURL（またはローカルの [public/index.html](file:///C:/Users/haxai/.gemini/antigravity/scratch/discord-vc-team-splitter/public/index.html)）をブラウザで開くと、サーバー内のVC一覧とメンバーが自動表示され、自由な人数指定・グループ数指定・ワンクリック除外切り替え・VC移動確認ポップアップがすべて画面上で操作できます。
