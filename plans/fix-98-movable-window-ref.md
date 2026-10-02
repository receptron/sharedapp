# fix: refuse a selfUpdate that can rewrite a window ref (#98)

MulmoServer's rules read `window.fromField` / `untilField` off `request.resource.data[ref]` on an
update (`refPath`), so a submitter allowed to rewrite `ref` can point their row at a record whose
window is open. #96 refused this for `withdrawUntilField`; the same guard now covers all three refs
(`movableWindowRefs`).

Risk: an app that publishes today with such a `selfUpdate` is newly refused. Checked: every
mulmoterminal template passes. `yarn check:apps` against the real apps checkout is still owed
before the release that ships this.
