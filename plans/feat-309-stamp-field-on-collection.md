# feat: the collection document names its stamp field (receptron/mulmoserver#309)

MulmoServer orders a records table newest first by `public.submit[cid].stampField`, read off the app
document — which only `*` readers may open. Staff with a role on one collection only got id order.

The collection's own document (`apps/{aid}/collections/{cid}`, read by `schemaRead`, the same people
who can list the rows) now carries `stampField` when the collection declares one; absent otherwise.
Additive: no rules change (publish writes the document as owner), no protocol change. MulmoServer
reads it there, falling back to the app document for apps published before this.
