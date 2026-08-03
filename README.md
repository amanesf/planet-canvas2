# 箱庭プラネット

地球規模の地形・気候変動を、誇張されたスケールで「見て気持ちいい」箱庭としてリアルタイムに動かすプロジェクト。設計の全体像は [`docs/design-memo.md`](docs/design-memo.md) を参照。

現状は見た目・操作感を確認するためのモックアップ（`src/main.ts`）。地形データはダミーのノイズで、実際のGPGPUシミュレーションはこれから積み上げていく。

## 開発

```
npm install
npm run dev
```

## ビルド / デプロイ

`main` に push すると GitHub Actions が `npm run build` して GitHub Pages に自動デプロイする（`.github/workflows/deploy.yml`）。
