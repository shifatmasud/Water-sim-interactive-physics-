/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { useMotionValue } from 'framer-motion';
import { useTheme } from '../../Theme.tsx';
import Toggle from '../Core/Toggle.tsx';
import RangeSlider from '../Core/RangeSlider.tsx';
import Select from '../Core/Select.tsx';

interface ControlPanelProps {
  isPaused: boolean;
  onTogglePause: () => void;
  lightAzimuth: number;
  onAzimuthChange: (value: number) => void;
  lightElevation: number;
  onElevationChange: (value: number) => void;
  skyPreset: string;
  onSkyPresetChange: (e: any) => void;
}

const SKY_PRESETS = [
    { value: 'default', label: 'Default Day' },
    { value: 'sunset', label: 'Sunset' },
    { value: 'cloudy', label: 'Cloudy' },
    { value: 'night', label: 'Night' },
];

const ControlPanel: React.FC<ControlPanelProps> = ({ 
    isPaused, 
    onTogglePause,
    lightAzimuth,
    onAzimuthChange,
    lightElevation,
    onElevationChange,
    skyPreset,
    onSkyPresetChange
}) => {
  const { theme } = useTheme();

  const azimuthMV = useMotionValue(lightAzimuth);
  const elevationMV = useMotionValue(lightElevation);

  React.useEffect(() => { azimuthMV.set(lightAzimuth) }, [lightAzimuth, azimuthMV]);
  React.useEffect(() => { elevationMV.set(lightElevation) }, [lightElevation, elevationMV]);

  const sectionDivider = <div style={{ borderTop: `1px solid ${theme.Color.Base.Surface[3]}`, margin: `0` }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing['Space.L'] }}>
      <p style={{ ...theme.Type.Readable.Body.M, color: theme.Color.Base.Content[2], margin: 0 }}>
        WebGL Water Controls
      </p>
      
      {sectionDivider}

      <Toggle
        label="Pause Simulation"
        isOn={isPaused}
        onToggle={onTogglePause}
      />
      
      {sectionDivider}

      <Select
        label="Sky Preset"
        value={skyPreset}
        onChange={onSkyPresetChange}
        options={SKY_PRESETS}
      />
      
      {sectionDivider}

      <RangeSlider
        label="Light Azimuth (°)"
        motionValue={azimuthMV}
        onCommit={onAzimuthChange}
        min={0}
        max={360}
      />

      <RangeSlider
        label="Light Elevation (°)"
        motionValue={elevationMV}
        onCommit={onElevationChange}
        min={0}
        max={90}
      />
    </div>
  );
};

export default ControlPanel;