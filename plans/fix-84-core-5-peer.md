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

**core 4.0.0 ではそうではなかった。** 4.0.0 の dist で `firebase` に届くのは `collection/firestore`
だけ — 名前が要求を言っている subpath だけだった。ただし 4 系の後半（4.9.2 / 4.10.0）では既に同じ
問題が出ており、退行は 4 系の途中で入っている。以前の CI は 4.0.0 固定だったので、ここも見えて
いなかった。mulmoclaude#3263 に上げた。

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

## core の API は変わっていないか

変わっていない — sharedapp が触る範囲では。読んで判断せず、三通りに回した:

1. **型宣言**: 使う記号（`isValidCollectionName` / `isSafeCustomViewPath` / `parseAppManifest` /
   `AppManifestResult` / `CollectionSchema` / `CollectionFieldSpec`）を宣言しているファイルを、4.0.0 と
   5.4.0 の tarball で突き合わせた。違いは `CollectionSummary` に省略可能な `color?` が増えたことだけで、
   sharedapp はこの型を使っていない。
2. **振る舞い**: `isValidCollectionName` / `isSafeCustomViewPath` / `parseAppManifest` を生成した入力で
   各版に呼び、答えを丸ごと比べた。
3. **sharedapp 自身**: このブランチのコードで `typecheck` と `test` を各版に対して回した。

| core | 使われている場所 | typecheck | test | 振る舞いの食い違い（5.4.0 と） |
|---|---|---|---|---|
| 4.0.0 | 以前の CI | OK | OK | 無し |
| 4.9.2 | mulmoserver | OK | OK | 無し |
| 4.10.0 | mulmoterminal | OK | OK | 無し |
| 5.3.0 | mulmoterminal#2209 | OK | OK | 無し |
| 5.4.0 | この変更 | OK | OK | — |

2 と 3 は、`firebase` の問題が API の違いを隠さないよう、どの版でも `firebase` を入れて回した。
版の間で本当に違うのは API ではなく、`collection/server` を `firebase` 無しで読めるかどうかだけ。

## peer は `^5.4.0` にする（core の最新を下限にする）

sharedapp は core の最新に追従する、という判断。下限を、この変更の時点での core の最新版に置く。

- **4 系を外すのは API の都合ではない。** 上のとおり、コードは 4.0.0 でもそのまま動く。外すのは、
  古い major を宣言し続けるならその major にも CI を回し続けなければならないから — 片方だけの
  devDependency で二つを宣言する状態こそ、二つの主張のうち一方を誰も検査していない状態。
- **5.0〜5.3 を外すのは `firebase` のため。** その範囲の `collection/server` は `firebase` 無しでは
  読めない。5.4.0 を下限にすれば、範囲内のどの版でも `firebase` が要らない。

### 利用側への影響

どちらの利用側も、main の時点では core 4 にいる。この変更を取り込んだ sharedapp に上げると、両方とも
`^5.4.0` の範囲の外になり、core を 5.4.0 以上へ上げるまで peer が合わない。

| 利用側 | 今の core | 範囲に戻るには |
|---|---|---|
| mulmoterminal | `^4.10.0` | 5.4.0 以上へ。core 5 へ移す receptron/mulmoterminal#2209 は未マージで、5.3.0 を狙っているので 5.4.0 に合わせる |
| mulmoserver | `4.9.2`（固定） | 5.4.0 以上へ（major を上げる） |

**公開は 0.36.0 として行う。** 利用側の宣言は `^0.35.0` で、0.x の caret は 0.36.0 を拾わないので、
利用側が明示的に上げるまで今の組み合わせはそのまま動く。0.35.1 として出すと、`^0.35.0` の利用側が
新規 install で自動的に拾い、core 4 のまま範囲外の peer を抱えることになる。

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

## 残課題

今は下限と開発依存がどちらも 5.4.0 を指すので、CI が回しているのは宣言範囲の中の唯一の版そのもの。
lockfile が 5.4.0 より先へ進んだ時点で、下限はまた誰も回していない主張に戻る。そのときは下限を
入れて回す CI の仕事を足すか、下限を上げる。
