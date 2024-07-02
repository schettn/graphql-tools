import type { GraphQLError } from 'graphql';
import { addPath, pathToArray } from '@graphql-tools/utils';
import { IncrementalGraph } from './IncrementalGraph.js';
import { invariant } from './invariant.js';
import type {
  CancellableStreamRecord,
  CompletedExecutionGroup,
  CompletedResult,
  DeferredFragmentRecord,
  DeliveryGroup,
  IncrementalDataRecord,
  IncrementalDataRecordResult,
  IncrementalDeferResult,
  IncrementalExecutionResults,
  IncrementalResult,
  IncrementalStreamResult,
  InitialIncrementalExecutionResult,
  PendingResult,
  StreamItemsResult,
  SubsequentIncrementalExecutionResult,
} from './types.js';
import {
  isCancellableStreamRecord,
  isCompletedExecutionGroup,
  isFailedExecutionGroup,
} from './types.js';

export function buildIncrementalResponse<TData = any>(
  context: IncrementalPublisherContext,
  result: TData,
  errors: ReadonlyArray<GraphQLError> | undefined,
  incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>,
): IncrementalExecutionResults<TData> {
  const incrementalPublisher = new IncrementalPublisher(context);
  return incrementalPublisher.buildResponse(result, errors, incrementalDataRecords);
}

interface IncrementalPublisherContext {
  sendIncrementalErrorsAsNull: boolean;
  sendPathAndLabelOnIncremental: boolean;
  signal: AbortSignal | undefined;
  cancellableStreams: Set<CancellableStreamRecord> | undefined;
}

interface SubsequentIncrementalExecutionResultContext<TData = any> {
  pending: Array<PendingResult>;
  incremental: Array<IncrementalResult<TData>>;
  completed: Array<CompletedResult>;
}

/**
 * The IncrementalPublisherState Enum tracks the state of the IncrementalPublisher, which is initialized to
 * "Started". When there are no more incremental results to publish, the state is set to "Completed". On the
 * next call to next, clean-up is potentially performed and the state is set to "Finished".
 *
 * If the IncrementalPublisher is ended early, it may be advanced directly from "Started" to "Finished".
 */
enum IncrementalPublisherState {
  Started = 1,
  Completed = 2,
  Finished = 3,
}

/**
 * This class is used to publish incremental results to the client, enabling semi-concurrent
 * execution while preserving result order.
 *
 * @internal
 */
class IncrementalPublisher {
  private _context: IncrementalPublisherContext;
  private _nextId: number;
  private _incrementalGraph: IncrementalGraph;

  constructor(context: IncrementalPublisherContext) {
    this._context = context;
    this._nextId = 0;
    this._incrementalGraph = new IncrementalGraph();
  }

  buildResponse<TData = unknown>(
    data: TData,
    errors: ReadonlyArray<GraphQLError> | undefined,
    incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>,
  ): IncrementalExecutionResults<TData> {
    const newPending = this._incrementalGraph.getNewPending(incrementalDataRecords);

    const pending = this._pendingSourcesToResults(newPending);

    const initialResult: InitialIncrementalExecutionResult<TData> =
      errors === undefined
        ? { data, pending, hasNext: true }
        : { errors, data, pending, hasNext: true };

    return {
      initialResult,
      subsequentResults: this._subscribe(),
    };
  }

  private _pendingSourcesToResults(newPending: ReadonlyArray<DeliveryGroup>): Array<PendingResult> {
    const pendingResults: Array<PendingResult> = [];
    for (const pendingSource of newPending) {
      const id = String(this._getNextId());
      pendingSource.id = id;
      const pendingResult: PendingResult = {
        id,
        path: pathToArray(pendingSource.path),
      };
      if (pendingSource.label !== undefined) {
        pendingResult.label = pendingSource.label;
      }
      pendingResults.push(pendingResult);
    }
    return pendingResults;
  }

  private _getNextId(): string {
    return String(this._nextId++);
  }

  private _subscribe<TData = any>(): AsyncGenerator<
    SubsequentIncrementalExecutionResult<TData>,
    void,
    void
  > {
    let incrementalPublisherState: IncrementalPublisherState = IncrementalPublisherState.Started;

    const _finish = async (): Promise<void> => {
      incrementalPublisherState = IncrementalPublisherState.Finished;
      this._incrementalGraph.abort();
      await this._returnAsyncIterators();
    };

    this._context.signal?.addEventListener('abort', () => {
      this._incrementalGraph.abort();
    });

    const _next = async (): Promise<
      IteratorResult<SubsequentIncrementalExecutionResult<TData>, void>
    > => {
      switch (incrementalPublisherState) {
        case IncrementalPublisherState.Finished: {
          return { value: undefined, done: true };
        }
        case IncrementalPublisherState.Completed: {
          await _finish();
          return { value: undefined, done: true };
        }
        case IncrementalPublisherState.Started: {
          // continue
        }
      }

      const context: SubsequentIncrementalExecutionResultContext<TData> = {
        pending: [],
        incremental: [],
        completed: [],
      };

      let batch: Iterable<IncrementalDataRecordResult> | undefined =
        this._incrementalGraph.currentCompletedBatch();
      do {
        for (const completedResult of batch) {
          this._handleCompletedIncrementalData(completedResult, context);
        }

        const { incremental, completed } = context;
        if (incremental.length > 0 || completed.length > 0) {
          const hasNext = this._incrementalGraph.hasNext();

          if (!hasNext) {
            incrementalPublisherState = IncrementalPublisherState.Completed;
          }

          const subsequentIncrementalExecutionResult: SubsequentIncrementalExecutionResult<TData> =
            {
              hasNext,
            };

          const pending = context.pending;
          if (pending.length > 0) {
            subsequentIncrementalExecutionResult.pending = pending;
          }
          if (incremental.length > 0) {
            subsequentIncrementalExecutionResult.incremental = incremental;
          }
          if (completed.length > 0) {
            subsequentIncrementalExecutionResult.completed = completed;
          }

          return { value: subsequentIncrementalExecutionResult, done: false };
        }

        batch = await this._incrementalGraph.nextCompletedBatch();
      } while (batch !== undefined);

      if (this._context.signal?.aborted) {
        throw this._context.signal.reason;
      }

      return { value: undefined, done: true };
    };

    const _return = async (): Promise<
      IteratorResult<SubsequentIncrementalExecutionResult<TData>, void>
    > => {
      await _finish();
      return { value: undefined, done: true };
    };

    const _throw = async (
      error?: unknown,
    ): Promise<IteratorResult<SubsequentIncrementalExecutionResult<TData>, void>> => {
      await _finish();
      return Promise.reject(error);
    };

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: _next,
      return: _return,
      throw: _throw,
    };
  }

  private _handleCompletedIncrementalData(
    completedIncrementalData: IncrementalDataRecordResult,
    context: SubsequentIncrementalExecutionResultContext,
  ): void {
    if (isCompletedExecutionGroup(completedIncrementalData)) {
      this._handleCompletedExecutionGroup(completedIncrementalData, context);
    } else {
      this._handleCompletedStreamItems(completedIncrementalData, context);
    }
  }

  private _handleCompletedExecutionGroup(
    completedExecutionGroup: CompletedExecutionGroup,
    context: SubsequentIncrementalExecutionResultContext,
  ): void {
    if (isFailedExecutionGroup(completedExecutionGroup)) {
      for (const deferredFragmentRecord of completedExecutionGroup.pendingExecutionGroup
        .deferredFragmentRecords) {
        const id = deferredFragmentRecord.id;
        if (!this._incrementalGraph.removeDeferredFragment(deferredFragmentRecord)) {
          // This can occur if multiple deferred grouped field sets error for a fragment.
          continue;
        }
        invariant(id !== undefined);
        if (this._context.sendIncrementalErrorsAsNull) {
          const incrementalEntry: IncrementalDeferResult = {
            id,
            data: null,
            errors: completedExecutionGroup.errors,
          };
          if (this._context.sendPathAndLabelOnIncremental) {
            const { path, label } = deferredFragmentRecord;
            incrementalEntry.path = pathToArray(path);
            if (label !== undefined) {
              incrementalEntry.label = label;
            }
          }
          context.incremental.push(incrementalEntry);
          context.completed.push({ id });
        } else {
          context.completed.push({
            id,
            errors: completedExecutionGroup.errors,
          });
        }
      }
      return;
    }

    this._incrementalGraph.addCompletedSuccessfulExecutionGroup(completedExecutionGroup);

    for (const deferredFragmentRecord of completedExecutionGroup.pendingExecutionGroup
      .deferredFragmentRecords) {
      const completion = this._incrementalGraph.completeDeferredFragment(deferredFragmentRecord);
      if (completion === undefined) {
        continue;
      }
      const id = deferredFragmentRecord.id;
      invariant(id !== undefined);
      const incremental = context.incremental;
      const { newPending, successfulExecutionGroups } = completion;
      context.pending.push(...this._pendingSourcesToResults(newPending));
      for (const successfulExecutionGroup of successfulExecutionGroups) {
        const { bestId, subPath } = this._getBestIdAndSubPath(
          id,
          deferredFragmentRecord,
          successfulExecutionGroup,
        );
        const incrementalEntry: IncrementalDeferResult = {
          ...successfulExecutionGroup.result,
          id: bestId,
        };
        if (this._context.sendPathAndLabelOnIncremental) {
          const { path, label } = deferredFragmentRecord;
          incrementalEntry.path = pathToArray(path);
          if (label !== undefined) {
            incrementalEntry.label = label;
          }
        }
        if (subPath !== undefined) {
          incrementalEntry.subPath = subPath;
        }
        incremental.push(incrementalEntry);
      }
      context.completed.push({ id });
    }
  }

  private _handleCompletedStreamItems(
    streamItemsResult: StreamItemsResult,
    context: SubsequentIncrementalExecutionResultContext,
  ): void {
    const streamRecord = streamItemsResult.streamRecord;
    const id = streamRecord.id;
    invariant(id !== undefined);
    if (streamItemsResult.errors !== undefined) {
      if (this._context.sendIncrementalErrorsAsNull) {
        const incrementalEntry: IncrementalStreamResult = {
          items: null,
          id,
          errors: streamItemsResult.errors,
        };
        if (this._context.sendPathAndLabelOnIncremental) {
          const { path, label, index } = streamRecord;
          incrementalEntry.path = pathToArray(addPath(path, index, undefined));
          if (label !== undefined) {
            incrementalEntry.label = label;
          }
        }
        context.incremental.push(incrementalEntry);
        context.completed.push({ id });
      } else {
        context.completed.push({
          id,
          errors: streamItemsResult.errors,
        });
      }
      this._incrementalGraph.removeStream(streamRecord);
      if (isCancellableStreamRecord(streamRecord)) {
        invariant(this._context.cancellableStreams !== undefined);
        this._context.cancellableStreams.delete(streamRecord);
        streamRecord.earlyReturn().catch(() => {
          /* c8 ignore next 1 */
          // ignore error
        });
      }
    } else if (streamItemsResult.result === undefined) {
      context.completed.push({ id });
      this._incrementalGraph.removeStream(streamRecord);
      if (isCancellableStreamRecord(streamRecord)) {
        invariant(this._context.cancellableStreams !== undefined);
        this._context.cancellableStreams.delete(streamRecord);
      }
    } else {
      const bareResult = streamItemsResult.result;
      const incrementalEntry: IncrementalStreamResult = {
        id,
        ...bareResult,
      };
      if (this._context.sendPathAndLabelOnIncremental) {
        const { path, label, index } = streamRecord;
        incrementalEntry.path = pathToArray(addPath(path, index, undefined));
        streamRecord.index += bareResult.items.length;
        if (label !== undefined) {
          incrementalEntry.label = label;
        }
      }
      context.incremental.push(incrementalEntry);

      const incrementalDataRecords = streamItemsResult.incrementalDataRecords;
      if (incrementalDataRecords !== undefined) {
        const newPending = this._incrementalGraph.getNewPending(incrementalDataRecords);
        context.pending.push(...this._pendingSourcesToResults(newPending));
      }
    }
  }

  private _getBestIdAndSubPath(
    initialId: string,
    initialDeferredFragmentRecord: DeferredFragmentRecord,
    completedExecutionGroup: CompletedExecutionGroup,
  ): { bestId: string; subPath: ReadonlyArray<string | number> | undefined } {
    let maxLength = pathToArray(initialDeferredFragmentRecord.path).length;
    let bestId = initialId;

    for (const deferredFragmentRecord of completedExecutionGroup.pendingExecutionGroup
      .deferredFragmentRecords) {
      if (deferredFragmentRecord === initialDeferredFragmentRecord) {
        continue;
      }
      const id = deferredFragmentRecord.id;
      // TODO: add test case for when an fragment has not been released, but might be processed for the shortest path.
      /* c8 ignore next 3 */
      if (id === undefined) {
        continue;
      }
      const fragmentPath = pathToArray(deferredFragmentRecord.path);
      const length = fragmentPath.length;
      if (length > maxLength) {
        maxLength = length;
        bestId = id;
      }
    }
    const subPath = completedExecutionGroup.path.slice(maxLength);
    return {
      bestId,
      subPath: subPath.length > 0 ? subPath : undefined,
    };
  }

  private async _returnAsyncIterators(): Promise<void> {
    await this._incrementalGraph.abort();

    const cancellableStreams = this._context.cancellableStreams;
    if (cancellableStreams === undefined) {
      return;
    }
    const promises: Array<Promise<unknown>> = [];
    for (const streamRecord of cancellableStreams) {
      if (streamRecord.earlyReturn !== undefined) {
        promises.push(streamRecord.earlyReturn());
      }
    }
    await Promise.all(promises);
  }
}
