# 箱庭プラネット

地球規模の地形・気候変動を、誇張されたスケールで「見て気持ちいい」箱庭としてリアルタイムに動かすプロジェクト。設計の全体像は [`docs/design-memo.md`](docs/design-memo.md) を参照。

現状は見た目・操作感を確認するためのモックアップ（`src/main.ts`）。大陸の大枠は実世界の標高データ（下記クレジット参照）、山肌の細部やその他の気候的な模様は手続き的ノイズで生成している。

## 開発

```
npm install
npm run dev
```

## ビルド / デプロイ

`main` に push すると GitHub Actions が `npm run build` して GitHub Pages に自動デプロイする（`.github/workflows/deploy.yml`）。

## アセットのクレジット

- `public/world-elevation.png`: [File:World elevation map.png](https://commons.wikimedia.org/wiki/File:World_elevation_map.png)（Wikimedia Commons、[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)）を縮小・グレースケール化して同梱。元データは NASA Blue Marble の地形・海底地形データを合成したもの。
