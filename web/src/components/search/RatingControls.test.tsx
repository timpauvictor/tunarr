import { describe, expect, test, beforeEach, vi } from 'vitest';
import { useForm, FormProvider } from 'react-hook-form';
import { ratingFieldKey } from '@tunarr/shared/util';
import { getApiProgramsRatingsFieldsQueryKey } from '../../generated/@tanstack/react-query.gen.ts';
import { ratingSearchFieldSpecs } from '../../helpers/ratingSearchFields.ts';
import useStore from '../../store/index.ts';
import {
  renderWithProviders,
  screen,
  seededQueryClient,
} from '../../test/utils.tsx';
import { NumericValueSearchNode } from './NumericValueSearchNode.tsx';
import { RatingSortControl } from './RatingSortControl.tsx';
import type { SearchForm } from './SearchInput.tsx';

const key = ratingFieldKey('imdb', 'audience');

beforeEach(() => useStore.setState({ currentSearchRequest: null }));

describe('ratings controls', () => {
  test('sets high/low score sort without losing the active query, and restores default ordering', async () => {
    useStore.setState({ currentSearchRequest: { query: 'example' } });
    const queryClient = seededQueryClient([
      [
        getApiProgramsRatingsFieldsQueryKey(),
        {
          fields: [
            {
              key,
              providerId: 'imdb',
              kind: 'audience',
              label: 'IMDb audience',
              ready: true,
            },
          ],
        },
      ],
    ]);
    const { user } = renderWithProviders(<RatingSortControl />, {
      queryClient,
    });
    await user.click(screen.getByRole('combobox', { name: 'Sort by' }));
    await user.click(
      screen.getByRole('option', { name: 'IMDb audience (0-100)' }),
    );
    expect(useStore.getState().currentSearchRequest).toEqual({
      query: 'example',
      sort: [{ field: key, direction: 'desc' }],
    });
    await user.click(screen.getByRole('combobox', { name: 'Direction' }));
    await user.click(screen.getByRole('option', { name: 'Lowest first' }));
    expect(useStore.getState().currentSearchRequest?.sort).toEqual([
      { field: key, direction: 'asc' },
    ]);
    await user.click(screen.getByRole('combobox', { name: 'Sort by' }));
    await user.click(screen.getByRole('option', { name: 'Default order' }));
    expect(useStore.getState().currentSearchRequest).toEqual({
      query: 'example',
      sort: undefined,
    });
  });

  test('edits fractional thresholds and both range bounds through the actual numeric editor', async () => {
    const submit = vi.fn();
    const spec = ratingSearchFieldSpecs([
      {
        key,
        providerId: 'imdb',
        kind: 'audience',
        label: 'IMDb audience',
        ready: true,
      },
    ]).find((spec) => spec.key === key);
    if (!spec) throw new Error('Missing fixture field');
    const activeSpec = spec;
    function Fixture() {
      const form = useForm<SearchForm>({
        defaultValues: {
          keywords: '',
          queryBuilderType: 'click',
          filter: {
            type: 'structured',
            filter: {
              type: 'value',
              fieldSpec: { key, type: 'numeric', op: 'to', value: [70, 90] },
            },
          },
        },
      });
      return (
        <FormProvider {...form}>
          <form onSubmit={form.handleSubmit((value) => submit(value))}>
            <NumericValueSearchNode
              uiSpec={activeSpec}
              formKey="filter.filter.fieldSpec"
            />
            <button type="submit">Apply</button>
          </form>
        </FormProvider>
      );
    }
    const { user } = renderWithProviders(<Fixture />);
    await user.clear(screen.getByLabelText('Lower value'));
    await user.type(screen.getByLabelText('Lower value'), '70.5');
    await user.clear(screen.getByLabelText('Upper value'));
    await user.type(screen.getByLabelText('Upper value'), '90.5');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          type: 'structured',
          filter: {
            type: 'value',
            fieldSpec: { key, type: 'numeric', op: 'to', value: [70.5, 90.5] },
          },
        },
      }),
    );
  });
});
