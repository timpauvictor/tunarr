import type {
  SearchFilter,
  SearchRequest,
  SearchSort,
} from '@tunarr/types/schemas';

export function librarySearchQuery(
  request: SearchRequest | null | undefined,
  defaultFilter?: SearchFilter | null,
  childFilter?: SearchFilter | null,
  childSort?: SearchSort[],
): SearchRequest {
  if (childFilter) {
    return {
      ...request,
      filter: request?.filter
        ? { type: 'op', op: 'and', children: [childFilter, request.filter] }
        : childFilter,
      sort: request?.sort ?? childSort,
    };
  }
  return { ...request, filter: request?.filter ?? defaultFilter };
}
