import type { MaybePromise } from './executor.js';
import { isAsyncIterable } from './isAsyncIterable.js';
import { isPromise } from './jsutils.js';

/**
 * Given an AsyncIterable and a callback function, return an AsyncIterator
 * which produces values mapped via calling the callback function.
 */
export function mapAsyncIterator<T, U>(
  iteratorOrIterable: AsyncIterable<T> | AsyncIterator<T>,
  onNext: (value: T) => MaybePromise<U>,
  onError?: (error: unknown) => unknown,
  onEnd?: () => MaybePromise<void>,
): AsyncIterableIterator<U> {
  let _mappedIterator: AsyncIterator<U>;

  function getMappedIterator() {
    if (_mappedIterator == null) {
      let _iterator: AsyncIterator<T>;
      let abruptClose: (error: unknown) => Promise<never>;
      function getIterator() {
        if (!_iterator) {
          _iterator = isAsyncIterable(iteratorOrIterable)
            ? iteratorOrIterable[Symbol.asyncIterator]()
            : iteratorOrIterable;
          if (typeof _iterator.return === 'function') {
            const $return = _iterator.return;
            abruptClose = (error: any) => {
              const rethrow = () => Promise.reject(error);
              return $return.call(_iterator).then(rethrow, rethrow);
            };
          }
        }
        return _iterator;
      }
      let onEndWithValue: <R>(value: R) => MaybePromise<R>;

      if (onEnd) {
        onEndWithValue = value => {
          const onEnd$ = onEnd();
          return isPromise(onEnd$) ? onEnd$.then(() => value) : value;
        };
      }

      function mapResult(result: any) {
        if (result.done) {
          return onEndWithValue ? onEndWithValue(result) : result;
        }
        return asyncMapValue(result.value, onNext).then(iteratorResult, abruptClose);
      }

      let mapReject: (error: unknown) => Promise<unknown>;
      if (onError) {
        // Capture rejectCallback to ensure it cannot be null.
        const reject = onError;
        mapReject = error => asyncMapValue(error, reject).then(iteratorResult, abruptClose);
      }
      _mappedIterator = {
        next(value) {
          return getIterator().next(value).then(mapResult, mapReject);
        },
        return(value) {
          const iterator = getIterator();
          const res$ = iterator.return
            ? iterator.return(value).then(mapResult, mapReject)
            : Promise.resolve({ value: undefined, done: true });
          return onEndWithValue ? res$.then(onEndWithValue) : res$;
        },
        throw(error) {
          const iterator = getIterator();
          if (typeof iterator.throw === 'function') {
            return iterator.throw(error).then(mapResult, mapReject);
          }
          return Promise.reject(error).catch(abruptClose);
        },
      };
    }
    return _mappedIterator;
  }

  return {
    get next() {
      return getMappedIterator().next;
    },
    get return() {
      return getMappedIterator().return;
    },
    get throw() {
      return getMappedIterator().throw;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function asyncMapValue<T, U>(value: T, callback: (value: T) => PromiseLike<U> | U): Promise<U> {
  return new Promise(resolve => resolve(callback(value)));
}

function iteratorResult<T>(value: T): IteratorResult<T> {
  return { value, done: false };
}
