// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { JSONTree } from 'react-json-tree';

interface JSONViewerProps {
  data: any;
  collapsed?: number | boolean;
  style?: React.CSSProperties;
}

/**
 * JSON Viewer Component with expand/collapse controls
 * Uses react-json-tree for beautiful, collapsible JSON display with visible arrows
 */
export const JSONViewer: React.FC<JSONViewerProps> = ({
  data,
  collapsed = 1,
  style = {},
}) => {
  // Custom theme matching our dark UI
  const theme = {
    scheme: 'happycmdb',
    author: 'HappyCMDB',
    base00: 'transparent', // background
    base01: '#2a2a2a', // lighter background
    base02: '#3a3a3a', // selection background
    base03: '#6e7681', // comments, invisibles
    base04: '#8b949e', // dark foreground
    base05: '#c9d1d9', // default foreground
    base06: '#d0d0d0', // light foreground
    base07: '#ffffff', // light background
    base08: '#f85149', // variables, XML tags, markup link text
    base09: '#ff9e64', // integers, boolean, constants
    base0A: '#e0af68', // classes, markup bold
    base0B: '#98c379', // strings, markup code
    base0C: '#56b6c2', // support, regex, escape chars
    base0D: '#5cc3fb', // functions, methods, headings (brand sky)
    base0E: '#bb9af7', // keywords, storage, selector
    base0F: '#e06c75', // deprecated, embedded
  };

  // Determine if nodes should be collapsed
  const shouldExpandNode = typeof collapsed === 'number'
    ? (keyPath: readonly (string | number)[], data: any, level: number) => level < collapsed
    : () => !collapsed;

  return (
    <div className="json-viewer-wrapper" style={style}>
      <JSONTree
        data={data}
        theme={theme}
        invertTheme={false}
        shouldExpandNodeInitially={shouldExpandNode}
        hideRoot={true}
      />
    </div>
  );
};

export default JSONViewer;
