import { usePlexLogin } from '@/hooks/plex/usePlexLogin.tsx';
import { t } from '@lingui/core/macro';
import type { SvgIconComponent } from '@mui/icons-material';
import { AddCircle } from '@mui/icons-material';
import { Button } from '@mui/material';

type AddPlexServer = {
  title?: string;
  variant?: 'text' | 'contained' | 'outlined' | undefined;
  icon?: SvgIconComponent;
};

export default function AddPlexServer({
  title = t`Add`,
  variant = 'contained',
  ...restProps
}: AddPlexServer) {
  const IconComponent = restProps.icon ?? AddCircle;
  const { startDiscovery, isPending } = usePlexLogin();

  return (
    <Button
      color="inherit"
      onClick={startDiscovery}
      disabled={isPending}
      variant={variant}
      startIcon={<IconComponent />}
      {...restProps}
    >
      {isPending ? t`Adding Plex servers…` : title}
    </Button>
  );
}
