/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import WebGLWater from '../Package/WebGLWater.tsx';

interface StageProps {
  lightAzimuth: number;
  lightElevation: number;
  skyPreset: string;
}

const Stage = ({ lightAzimuth, lightElevation, skyPreset }: StageProps) => {
  return (
    <div style={{ 
        position: 'relative', 
        width: '100%',
        height: '100%',
    }}>
        <WebGLWater 
            lightAzimuth={lightAzimuth}
            lightElevation={lightElevation}
            skyPreset={skyPreset}
        />
    </div>
  );
};

export default Stage;