import { describe, expect, test } from 'vitest';
import { makeMovie } from '../../test/programFixtures.ts';
import { renderWithProviders, screen } from '../../test/utils.tsx';
import { ProgramRatings } from './ProgramRatings.tsx';

describe('ProgramRatings', () => {
  test('shows genuine public zero, excludes personal stars, and distinguishes missing metadata', async () => {
    const program = makeMovie({
      sourceType: 'plex',
      ratings: {
        version: 1,
        observedAt: 100,
        entries: [
          {
            providerId: 'imdb',
            kind: 'audience',
            value: 0,
            scale: 10,
            score: 0,
          },
          {
            providerId: 'plex',
            kind: 'personal',
            value: 8,
            scale: 10,
            score: 80,
          },
        ],
      },
    });
    const view = renderWithProviders(<ProgramRatings program={program} />);
    const label = screen.getByText(/0\.00\/100/);
    await view.user.hover(label);
    expect(
      await screen.findByText('IMDb audience: 0/10 (0/100)'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Personal: 4/5 stars (8/10), excluded from Omnirating.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Contributing scores: 1')).toBeInTheDocument();
    view.rerender(
      <ProgramRatings
        program={makeMovie({ sourceType: 'plex', ratings: null })}
      />,
    );
    expect(screen.getByText(/Unknown/)).toBeInTheDocument();
  });
});
