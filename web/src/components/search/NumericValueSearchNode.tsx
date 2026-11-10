import { useLingui } from '@lingui/react/macro';
import type { SearchFieldSpec } from '@/helpers/searchBuilderConstants.ts';
import { numericBij } from '@/helpers/searchBuilderConstants.ts';
import type { FieldKey, FieldPrefix } from '@/types/SearchBuilder.ts';
import { Stack, TextField } from '@mui/material';
import { isNumber2Tuple } from '@tunarr/shared/util';
import { isNumber } from 'lodash-es';
import { useState } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import type { SearchForm } from './SearchInput.tsx';

type Props = {
  uiSpec: SearchFieldSpec<'numeric'>;
  formKey: FieldKey<FieldPrefix, 'fieldSpec'>;
};

function NumericDraftInput({
  value,
  uiSpec,
  label,
  onChange,
  onBlur,
}: {
  value: number;
  uiSpec: SearchFieldSpec<'numeric'>;
  label: string;
  onChange: (value: number) => void;
  onBlur: () => void;
}) {
  const { t } = useLingui();
  // A focused draft owns unfinished decimals such as "70.". The form keeps
  // the last valid numeric value; blur abandons an invalid draft, not as zero.
  const [draft, setDraft] = useState<string>();
  const bijection = uiSpec.uiBijection ?? numericBij;
  const displayValue = uiSpec.bijection ? uiSpec.bijection.from(value) : value;
  const text = draft ?? bijection.to(displayValue);
  const parsed = text.trim() === '' ? NaN : bijection.from(text);
  const valid =
    Number.isFinite(parsed) &&
    (!uiSpec.valueBounds ||
      (parsed >= uiSpec.valueBounds.min && parsed <= uiSpec.valueBounds.max));
  return (
    <TextField
      label={label}
      size="small"
      value={text}
      error={draft !== undefined && !valid}
      helperText={
        draft !== undefined && !valid
          ? t`Enter a valid number in the displayed scale.`
          : undefined
      }
      slotProps={{ htmlInput: { inputMode: 'decimal' } }}
      onFocus={() => setDraft(bijection.to(displayValue))}
      onBlur={() => {
        setDraft(undefined);
        onBlur();
      }}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (next.trim() === '') return;
        const parsed = bijection.from(next);
        if (
          !Number.isFinite(parsed) ||
          (uiSpec.valueBounds &&
            (parsed < uiSpec.valueBounds.min ||
              parsed > uiSpec.valueBounds.max))
        )
          return;
        const result = uiSpec.bijection ? uiSpec.bijection.to(parsed) : parsed;
        if (Number.isFinite(result)) onChange(result);
      }}
    />
  );
}

export function NumericValueSearchNode({ uiSpec, formKey }: Props) {
  const { t } = useLingui();
  const { control } = useFormContext<SearchForm>();
  return (
    <Controller
      control={control}
      name={`${formKey}.value`}
      render={({ field }) => {
        const value = field.value;
        if (isNumber(value)) {
          return (
            <NumericDraftInput
              value={value}
              uiSpec={uiSpec}
              label={uiSpec.valueBounds ? t`Score (0-100)` : t`Value`}
              onChange={field.onChange}
              onBlur={field.onBlur}
            />
          );
        }
        if (!isNumber2Tuple(value)) return <></>;
        return (
          <Stack direction="row" gap={1}>
            <NumericDraftInput
              value={value[0]}
              uiSpec={uiSpec}
              label={t`Lower value`}
              onChange={(next) => field.onChange([next, value[1]])}
              onBlur={field.onBlur}
            />
            <NumericDraftInput
              value={value[1]}
              uiSpec={uiSpec}
              label={t`Upper value`}
              onChange={(next) => field.onChange([value[0], next])}
              onBlur={field.onBlur}
            />
          </Stack>
        );
      }}
    />
  );
}
