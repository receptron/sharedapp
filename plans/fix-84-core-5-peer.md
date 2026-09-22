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

**振る舞いは変わっていない。型は追加だけ変わった。** sharedapp が壊れることは無い。読んで判断せず、実際に回した:

1. **型宣言**: `CollectionSchema` と `CollectionFieldSpec` は、`schema.d.ts` では
   `z.infer<typeof CollectionSchemaZ>` / `z.infer<typeof FieldSpecZ>` と書かれているだけで、形の実体は
   `schemaZ.d.ts` にある。こちらは 4.0.0 → 5.4.0 で**変わっている** — すべて追加:
   - 列挙フィールドに `default?`
   - カスタムビューに `allowSendChat?`
   - `propagateDeletes?` と `color`
   - カレンダーの取り込み元フィールドの列挙が広がった

   それ以外に使う記号（`isValidCollectionName` / `isSafeCustomViewPath` / `parseAppManifest` /
   `AppManifestResult`）の宣言は同じ。最初は `schema.d.ts` だけを比べて「同じ」と書いていた —
   `z.infer` の先を見ていなかった。
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

### 追加されたキーの影響

- sharedapp は追加されたキーを一つも名指ししていない。検査も射影も、これらに反応しない。
- ただし `schemaDoc` は schema を**そのまま** `publishedSchema` に入れて公開する（ビューがどこを使うかを
  推測しない、という設計）。schema を読むのは利用側で、zod のオブジェクトは知らないキーを既定で落とす
  ので、利用側が core 4 で読めば新しいキーは消え、core 5.4 で読めば残って公開される。
- mulmoserver の `firestore.rules` では、schema 文書（`apps/{aid}/collections/{cid}`）の書き込み条件は
  owner であることだけで、キーを縛らない。rules は `publishedSchema` を読まない。公開が拒まれることも、
  何かを許すことも無く、クライアントに見えるようになるだけ。
- 追加されたキーのうち、公開前の検査が要るものがあるかもしれない（列挙の `default` と `initialStatus` /
  `transitions.initial` の食い違い、公開コレクションでの `propagateDeletes`）。#84 の外の新しい機能の話。

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

`format:check` / `lint` / `build` / `typecheck` / `test` / `lint:overrides` / `typecheck:summary` を core 5.4.0 で
回す。加えて接触面の試験を `test/test_coreCompat.ts` に置いた: 呼んで期待どおり答えるところまで見る。

固定したもの:

- `isValidCollectionName` — 受理する形と、path の一部になり得るものの拒否
- `isSafeCustomViewPath` — 登る形・拡張子違い・前置の大文字違いの拒否。**下位ディレクトリは core が
  許し、一ファイル規則はこちらの `split("/")` 側が持っている**という分担も固定した。core が締めれば
  こちらの守りは死んだコードになり、core が緩めればこちらは登る形を通し続ける
- `parseAppManifest` — `ok` / `kind` / `detail` の形。`detail` は `missing` 以外の枝にしか無く、
  その非対称こそ `parseAuthoredApp` が符号化しているもの。`detail` を持たない枝が増えれば
  あの一行が壊れる
- **subpath ごとに、引いている名前そのもの。** 実行時に読み込むもの（値・副作用だけの import・動的
  `import()`）と、型だけのものを分けて固定した。`server` から二つ目の名前を引いても、新しい subpath に
  触れても赤くなる。型も固定するのは、公開シグネチャに出る型は `.d.ts` に書き出され、利用側の
  コンパイラが自分の core に対して解決するから
- **`firebase` が入っていないこと。** `src` を読む試験が通ること自体が「下限で `collection/server` は
  `firebase` 無しに読める」の証拠で、`firebase` が別の理由で入った瞬間にその証拠は空になる

import の読み取りは、文字列の照合ではなく構文木（`ts.createSourceFile`）で行う。コメントや文字列の中の
「import らしきもの」は数えず、複数行にまたがる句も同じ句として読み、副作用だけの `import "…"` と動的
`import()` も拾う。`verbatimModuleSyntax` の下では `import type` / `export type` の句だけが消え、
`import { type A } from` は `import {} from` として残ってモジュールを読み込む（実際にコンパイルして
確かめた）ので、そのとおりに数える。読み取り自身も、拾うべき形と拾ってはいけない形の両方を、人工の
入力で確かめている。

壊して確かめたこと（壊す前と戻した後に、ファイルが元どおりかを毎回確かめた）:

| 壊し方 | 結果 |
|---|---|
| `server` から二つ目の名前を引く | 実行時の固定が赤 |
| 呼ばれない関数の中で `collection/firestore` を動的 `import()` | 実行時の固定が赤 |
| 新しい subpath から型だけ引く | 型の固定が赤 |
| コメントに core の import を書く | 緑のまま（数えない） |
| 「型だけか」の判定を壊す | 読み取りの自己試験・実行時の固定・型の固定が赤 |
| `firebase` を解決できる状態にする | `firebase` の試験が赤 |

CI に `core-floor` を足した。peer が名乗る**下限**そのものを入れて `typecheck` と `test` を回す。ほかの
仕事は lockfile が持つ版で回り、最初の定期更新で下限より上へずれるので、この仕事が無いと宣言した下限は
誰も回していない主張に戻る。下限は `package.json` から読み取り、`^X.Y.Z` 一つとして読めない範囲なら
別の版を試験せずに失敗する。

依存を入れ替えたので、`node_modules` を消して `yarn install --frozen-lockfile` からの
クリーン install で上のゲートを回し直してある。warm な `node_modules` は、lockfile が落とした
推移的依存をまだ持っているので嘘をつく。

## その後

計画の時点で残していた二つは、どちらもこの版のあとで片付いた。

- **view 側の守りの誤り** → issue #87 / PR #89。構文木の読み取り（`test/importScan.ts`）に寄せて解消し、
  読み取りが二つあった重複も同時に消えた。さらに PR #90 で「`view/` にサブディレクトリを置かない」を
  足した — Codex のレビューが「走査が直下だけ」を指摘し、配信側を辿ったところ、許可リストが再帰しない
  ので入れ子は外を読み込まなくても 404 すると分かったため。再帰にするだけでは足りなかった。
- **追加されたキーの公開前検査** → issue #88。`default` はフォームの開始値で、それを読むのは
  mulmoclaude の中だけ。sharedapp も mulmoserver も読んでいないので、公開の経路には届かない。いま足す
  検査は無いという結論で閉じた。開き直す条件は issue に記録してある。
