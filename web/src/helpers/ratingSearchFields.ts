import { parseRatingFieldKey, ratingFieldLabel } from '@tunarr/shared/util';
import type { RatingFieldDescriptor } from '@tunarr/types/schemas';
import type { SearchFieldSpec } from './searchBuilderConstants.ts';

const decimalBijection = {
  to: (value: number) => value.toString(),
  from: (value: string) => (value.trim() === '' ? NaN : Number(value)),
};

export function ratingSearchFieldSpecs(
  fields: readonly RatingFieldDescriptor[],
  currentKey?: string,
): SearchFieldSpec<'numeric'>[] {
  const choices = [...fields];
  const identity = currentKey ? parseRatingFieldKey(currentKey) : undefined;
  if (
    identity &&
    currentKey &&
    !choices.some((field) => field.key === currentKey)
  ) {
    choices.push({
      ...identity,
      key: currentKey,
      label: ratingFieldLabel(identity),
      ready: false,
    });
  }
  return [
    {
      key: 'omnirating',
      displayName: 'Omnirating (0-100)',
      type: 'numeric',
      uiVisible: true,
      visibleForLibraryTypes: 'all',
      uiBijection: decimalBijection,
      valueBounds: { min: 0, max: 100 },
    },
    ...choices.map((field) => ({
      key: field.key,
      displayName: `${field.label} (0-100)`,
      type: 'numeric' as const,
      uiVisible: true,
      visibleForLibraryTypes: 'all' as const,
      uiBijection: decimalBijection,
      valueBounds: { min: 0, max: 100 },
      disabled: !field.ready,
    })),
  ];
}
