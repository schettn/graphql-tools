---
'@graphql-tools/executor': major
'@graphql-tools/utils': minor
---

Upgrade to non-duplicating Incremental Delivery format

## Description

GraphQL Incremental Delivery is moving to a [new response format without duplication](https://github.com/graphql/defer-stream-wg/discussions/69).

This PR updates the executor within graphql-tools to follow the new format, a BREAKING CHANGE.

Incremental Delivery has now been disabled for subscriptions, also a BREAKING CHANGE. The GraphQL Working Group has decided to disable incremental delivery support for subscriptions (1) to gather more information about use cases and (2) explore how to interleaving the incremental response streams generated from different source events into one overall subscription response stream.

Library users can explicitly opt in to the older format by call `execute` with the following granular options:

```ts
const result = await execute({
  ...,
  deduplicateDefers: false,
  sendIncrementalErrorsAsNull: true,
  sendPathAndLabelOnIncremental: true,
  errorWithIncrementalSubscription: false,
});

Setting `deduplicateDefers` to `true` or omitting this option will deduplicate deferred data, the new standard. Setting `deduplicateDefers` to `false` will re-enable deduplication according to the older format.

Setting `sendIncrementalErrorsAsNull` to `false` or omitting this option will send incremental errors (i.e. errors that bubble up to a position that has already been sent) within the `errors` field on the new `completed` entry, the new standard. Setting `sendIncrementalErrorsAsNull` to `true` will continue sending these errors an incremental entries where  the `data` or `items` field is set to `null`, following the older format.

Setting `sendPathAndLabelOnIncremental` to `false` or omitting this option will not include `path` and `label` within incremental entries, such that clients will have to rely on the `id` field, the new standard. Setting `sendPathAndLabelOnIncremental` to `true` will still include `path` and `label` along with the new `id` field, matching the older format.

Setting `errorWithIncrementalSubscription` to `true` or omitting this option will raise errors whenever incremental delivery is utilized with subscriptions as the new standard no longer officially supports this case. Setting `errorWithIncrementalSubscription` to `false` will explicitly re-enable this behavior.
```
