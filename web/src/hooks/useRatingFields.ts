import { useQuery } from '@tanstack/react-query';
import { getApiProgramsRatingsFieldsOptions } from '../generated/@tanstack/react-query.gen.ts';

export function useRatingFields() {
  return useQuery({
    ...getApiProgramsRatingsFieldsOptions(),
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.fields.some((field) => !field.ready) ? 1_000 : false,
  });
}
