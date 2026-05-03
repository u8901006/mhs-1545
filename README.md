# mhs-1545

台北市心理諮商合作機構尚有名額清單，每週一台灣時間 01:00 由 GitHub Actions 自動更新並部署到 GitHub Pages。

## Data Flow

1. 從衛福部心理健康支持方案網站查詢台北市、尚有名額的合作機構。
2. 使用 `data/taipeupsy.html` 作為可推薦診所名單參考。
3. 交由 Zhipu GLM 過濾，只保留參考頁有填寫的診所。
4. 產生 `docs/index.html`，由 GitHub Pages 發布。

## Required Secret

`ZHIPU_API_KEY` must be configured as a GitHub Actions secret.
