import EmbyIcon from '@/assets/emby.svg?react';
import JellyfinIcon from '@/assets/jellyfin.svg?react';
import PlexIcon from '@/assets/plex.svg?react';
import { usePlexLogin } from '@/hooks/plex/usePlexLogin.tsx';
import { Trans } from '@lingui/react/macro';
import { Add, Computer, YouTube } from '@mui/icons-material';
import {
  Box,
  Button,
  type ButtonProps,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  SvgIcon,
} from '@mui/material';
import type { MediaSourceType } from '@tunarr/types';
import { isNull } from 'lodash-es';
import { useState } from 'react';
import { EmbyServerEditDialog } from './EmbyServerEditDialog.tsx';
import { JellyfinServerEditDialog } from './JelllyfinServerEditDialog.tsx';
import { LocalMediaEditDialog } from './LocalMediaEditDialog.tsx';
import { PlexServerEditDialog } from './PlexServerEditDialog.tsx';
import { YouTubeMediaSourceDialog } from './YouTubeMediaSourceDialog.tsx';

type Props = {
  ButtonProps?: ButtonProps;
};

export function AddMediaSourceButton({ ButtonProps }: Props) {
  const [manualAddPopoverRef, setManualAddPopoverRef] =
    useState<HTMLButtonElement | null>(null);

  const [selectedDialog, setSelectedDialog] = useState<MediaSourceType>();
  const { startDiscovery, isPending } = usePlexLogin();

  const open = !isNull(manualAddPopoverRef);

  const openManualAddButtonMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    setManualAddPopoverRef(event.currentTarget);
  };

  const closeManualAddButtonMenu = () => {
    setManualAddPopoverRef(null);
  };

  const handleDiscoverPlexServers = () => {
    startDiscovery();
    closeManualAddButtonMenu();
  };

  const handleOpenMediaSourceDialog = (source: MediaSourceType) => {
    setSelectedDialog(source);
    closeManualAddButtonMenu();
  };

  return (
    <Box>
      <Button
        color="primary"
        onClick={openManualAddButtonMenu}
        variant="contained"
        startIcon={<Add />}
        {...ButtonProps}
      >
        <Trans>Add</Trans>
      </Button>
      <Menu
        open={open}
        anchorEl={manualAddPopoverRef}
        onClose={closeManualAddButtonMenu}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'left',
        }}
        slotProps={{
          paper: {
            sx: { minWidth: 150 },
          },
        }}
      >
        <MenuItem
          disabled={isPending}
          onClick={() => handleDiscoverPlexServers()}
        >
          <ListItemIcon>
            <SvgIcon>
              <PlexIcon />
            </SvgIcon>
          </ListItemIcon>
          <ListItemText>
            {isPending ? (
              <Trans>Adding Plex servers…</Trans>
            ) : (
              <Trans>Plex (Auto)</Trans>
            )}
          </ListItemText>
        </MenuItem>
        <MenuItem onClick={() => handleOpenMediaSourceDialog('plex')}>
          <ListItemIcon>
            <SvgIcon>
              <PlexIcon />
            </SvgIcon>
          </ListItemIcon>
          <ListItemText>
            <Trans>Plex (Manual)</Trans>
          </ListItemText>
        </MenuItem>
        <MenuItem onClick={() => handleOpenMediaSourceDialog('jellyfin')}>
          <ListItemIcon>
            <SvgIcon>
              <JellyfinIcon />
            </SvgIcon>
          </ListItemIcon>
          <ListItemText>
            <Trans>Jellyfin</Trans>
          </ListItemText>
        </MenuItem>
        <MenuItem onClick={() => handleOpenMediaSourceDialog('emby')}>
          <ListItemIcon>
            <SvgIcon>
              <EmbyIcon />
            </SvgIcon>
          </ListItemIcon>
          <ListItemText>
            <Trans>Emby</Trans>
          </ListItemText>
        </MenuItem>
        <MenuItem onClick={() => handleOpenMediaSourceDialog('local')}>
          <ListItemIcon>
            <Computer />
          </ListItemIcon>
          <ListItemText>
            <Trans>Local</Trans>
          </ListItemText>
        </MenuItem>
        <MenuItem onClick={() => handleOpenMediaSourceDialog('youtube')}>
          <ListItemIcon>
            <YouTube />
          </ListItemIcon>
          <ListItemText>
            <Trans>YouTube</Trans>
          </ListItemText>
        </MenuItem>
      </Menu>
      <PlexServerEditDialog
        open={selectedDialog === 'plex'}
        onClose={() => setSelectedDialog(undefined)}
      />
      <JellyfinServerEditDialog
        open={selectedDialog === 'jellyfin'}
        onClose={() => setSelectedDialog(undefined)}
      />
      <EmbyServerEditDialog
        open={selectedDialog === 'emby'}
        onClose={() => setSelectedDialog(undefined)}
      />
      <LocalMediaEditDialog
        open={selectedDialog === 'local'}
        onClose={() => setSelectedDialog(undefined)}
      />
      <YouTubeMediaSourceDialog
        open={selectedDialog === 'youtube'}
        onClose={() => setSelectedDialog(undefined)}
      />
    </Box>
  );
}
