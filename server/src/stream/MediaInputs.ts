import type { NonEmptyArray } from 'ts-essentials';
import type {
  FileStreamSource,
  HttpStreamSource,
  StreamSource,
} from './types.ts';

export type MediaInput = {
  id: string;
  source: StreamSource;
};

// Existing single-input callers keep their supported call shape. A collection
// is exclusive with it, so there are never two authorities for an input.
export type MediaInputSet =
  | { source: StreamSource; inputs?: never }
  | { source?: never; inputs: NonEmptyArray<MediaInput> };

export function mediaInputs(stream: MediaInputSet): NonEmptyArray<MediaInput> {
  const inputs = stream.inputs ?? [{ id: 'main', source: stream.source }];
  if (
    inputs.length === 0 ||
    inputs.some((input) => !input.id) ||
    new Set(inputs.map((input) => input.id)).size !== inputs.length
  ) {
    throw new Error('Media inputs need unique non-empty identities.');
  }
  return inputs;
}

export function selectMediaInput(
  inputs: NonEmptyArray<MediaInput>,
  inputId: string | undefined,
): MediaInput & { source: HttpStreamSource | FileStreamSource } {
  const input =
    inputId === undefined && inputs.length === 1
      ? inputs[0]
      : inputs.find((candidate) => candidate.id === inputId);
  if (!input) {
    throw new Error(
      'The selected track must identify an available media input.',
    );
  }
  if (input.source.type !== 'file' && input.source.type !== 'http') {
    throw new Error('Unsupported media input source.');
  }
  return { id: input.id, source: input.source };
}
