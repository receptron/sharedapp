# feat: publishField / public.readPublished (#93)

The publishing half of receptron/mulmoserver#316. The rules and the front-end shipped first
(receptron/mulmoserver#317, deployed), so an app declaring these keys works the moment this
package publishes them.

## Changes

- Manifest: `collections[cid].publishField`, `public.readPublished`
- Projection: `apps/{aid}.public.readPublished` (read by the rules), and
  `config/public.readPublished: { <cid>: <publishField> }` (read by the page)
- Gate (`publishReadPublished.ts`) refuses:
  - a `readPublished` cid with no `publishField`
  - the same cid in `public.read` as well (every row would be public)
  - `publishField` in `createFields` or any `selfUpdate` list
  - `publishField` equal to the status / assignee / stamp / id / uid / email field
- A `public` view may be handed a `readPublished` cid; the unknown-cid check names the key
- No protocol bump: an older reader leaves the dataset out rather than drawing it wrong

## Verification

`test/test_readPublished.ts`: the box publishes clean, each refusal fires on its fragment, the
projection writes both documents, and an app declaring none projects nothing new. Removing the gate
call makes half of them fail.
