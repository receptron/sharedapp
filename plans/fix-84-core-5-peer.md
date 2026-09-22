# peer を core 5 に合わせる (#84)

## なぜ気づけなかったか

`peerDependencies` は `@mulmoclaude/core: ^4.0.0`、`devDependencies` は `"4.0.0"` の完全固定。
CI は Node の行列で `typecheck` と `test` を回すが、その全部が 4.0.0 に対してだけ走っていた。
**このリポジトリは core 5 を一度もコンパイルしたことがない。** だから宣言と実態がずれても赤くなる
ものが無く、気づいたのは利用側（MulmoTerminal）の依存監査だった。

直すのは版数の文字列ではなく、**その盲点**のほうが本体。

## core 5.3.0 を入れて分かったこと

`yarn typecheck` は通る。`yarn test` は、`collection/server` まで届くファイルで落ちる:

```
Cannot find package 'firebase' imported from …/@mulmoclaude/core/dist/discovery-….js
```

core 5 の `@mulmoclaude/core/collection/server` の入口が、discovery の塊を**静的に**取り込み、
それが `firebase` を import していた。core は `firebase` を **optional な peer** と宣言している
(`peerDependenciesMeta.firebase.optional = true`) ので、入れていない利用者がいて当然であり、
その利用者はこの subpath を読めなかった。

**core 4 ではそうではなかった。** 4.0.0 の dist で `firebase` に届くのは `collection/firestore`
だけ — 名前が要求を言っている subpath だけだった。core 5 の退行であり、mulmoclaude#3263 に上げた。

## 上流が 5.4.0 で直した

mulmoclaude#3264 がマージされ、core 5.4.0 として公開された。原因は `collection/server` の barrel が
`sharedItemsPath`（純粋な文字列組み立て）を**値として**再 export しており、その一本の辺が
`firebase/firestore` を eager に繋いでいたこと。

公開時刻から推測せず、実物で確かめた。空の置き場に core だけを入れ（`firebase` は無し）、
`collection/server` を import する:

| core | `firebase` 無しで `collection/server` |
|---|---|
| 5.3.0（対照） | `Cannot find package 'firebase'` |
| 5.4.0 | 読める |

対照が同じ手順で落ちるので、この試し測りは差を見分けられている。

## `firebase` は一度足して、外した

5.4.0 が出る前は、`firebase` を開発依存に足して試験を回していた（出荷物には入らない回避策）。
5.4.0 で要らなくなったので外した。

外すときは **peer の下限と対で動かした。** `firebase` だけ落として下限を 5.0.0 のままにすると、
開発依存が解決する「直った core」に対してだけ検査が回り、宣言のほうは「直っていない 5.0.0〜5.3.x
でも動く」と言い続ける — 盲点が逆向きに戻る。`firebase` を持たない利用者にとって、その宣言は偽になる。

## 接触面を狭める

core から使っている記号は下の表のものだけ。うち一つは、より軽い subpath に移せる:

| 記号 | 前 | 後 |
|---|---|---|
| `isValidCollectionName` | `core/collection` | 変えない（軽い入口） |
| `isSafeCustomViewPath` | `core/collection/server` | **`core/collection/paths`** へ |
| `parseAppManifest` | `core/collection/server` | 変えられない（ここにしか無い） |
| `CollectionSchema` / `CollectionFieldSpec`（型） | `core/collection` | 変えない |

5.4.0 でも `collection/server` は core のサーバ側の半分で、一つの記号のために触れれば全体が読み込まれる。
`isSafeCustomViewPath` は `paths` にもあるので、`server` に触れる記号を `parseAppManifest` 一つに
絞った。いま実行時の重さは変わらない（`parseAppManifest` のために `server` はどのみち読まれる）が、
core が `parseAppManifest` に軽い置き場を与えたとき、`server` を一回の変更で手放せる形になる。

`parseAppManifest` は `aid` の規則を一箇所に保つために共有しているもので（CLAUDE.md に明記）、
こちらで書き直せば規則が二箇所になる。だから `server` に残す。

## peer は `^5.4.0` にする

**`^5.0.0` にしない理由** — 上のとおり、5.0.0〜5.3.x は `firebase` 無しでは `collection/server` を
読めない。それを含む範囲を宣言すると、`firebase` を持たない利用者に対して偽の主張になる。

**`^4 || ^5` にしない理由**:

- 利用者は core 5 で動いている。
- 両方を宣言するなら、両方に対して CI を回さなければ**同じ盲点が逆向きに戻る** — 片方だけの
  devDependency は、二つの主張のうち一方を誰も検査していない状態そのもの。

使われていない版を宣言し続ける代わりに、**動かして確かめられる範囲だけを宣言する。**

### 利用側への影響

MulmoTerminal は receptron/mulmoterminal#2209 で core 5.3.0 に上がったところなので、この変更の後は
**`^5.4.0` の範囲の外になる**。5.4.0 へ上げれば戻る（上げれば 5.3.0 の `firebase` 問題も一緒に消える）。
他の利用者の core の版は、この変更の時点では確かめていない。

## 検証

`format:check` / `lint` / `typecheck` / `test` / `lint:overrides` / `typecheck:summary` を core 5.4.0 で
回す。加えて接触面の試験を `test/test_coreCompat.ts` に置いた: 呼んで期待どおり答えるところまで見る
（「resolve できる」では、落ちたのが実行時の話だったので足りないことが今回はっきりした）。

固定したもの:

- `isValidCollectionName` — 受理する形と、path の一部になり得るものの拒否
- `isSafeCustomViewPath` — 登る形・拡張子違い・前置の大文字違いの拒否。**下位ディレクトリは core が
  許し、一ファイル規則はこちらの `split("/")` 側が持っている**という分担も固定した。core が締めれば
  こちらの守りは死んだコードになり、core が緩めればこちらは登る形を通し続ける
- `parseAppManifest` — `ok` / `kind` / `detail` の形。`detail` は `missing` 以外の枝にしか無く、
  その非対称こそ `parseAuthoredApp` が符号化しているもの。`detail` を持たない枝が増えれば
  あの一行が壊れる
- **import 元の集合そのもの**。値として引く subpath を並べて固定したので、`collection/server` への
  依存が増えれば赤くなる

最後のものは源文走査なので、黙って素通りする形になっていないことを変異で確かめた:
import を `paths` から `server` に戻すと当該の試験が赤くなり、走査が `src/` を見失う変異でも赤くなる
（何も見つけられなかった走査は「見つけなかったこと」について何を主張しても通るので、
走査自身が獲物を捉えていることを先に主張させてある）。

`firebase` を外した後の試験が通ること自体が、下限 5.4.0 で `collection/server` が `firebase` 無しに
読めることの証明になっている — `firebase` が要るなら、`src` を読み込む試験がすべて落ちる。

依存を入れ替えたので、`node_modules` を消して `yarn install --frozen-lockfile` からの
クリーン install で上のゲートを回し直してある。warm な `node_modules` は、lockfile が落とした
推移的依存をまだ持っているので嘘をつく。
