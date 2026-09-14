import type { BotCartridgeData } from '../../../types/bot';
import {
  TERMINAL_ATTACH_Y,
  TERMINAL_BASE_LAYER,
  TERMINAL_BASE_Y,
  TERMINAL_BOTTOM_ORIGIN_Y,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MIN_WIDTH,
  TERMINAL_ORIGIN_X,
  TERMINAL_SP_ORIGIN_X,
  TERMINAL_SP_ORIGIN_Y,
  TERMINAL_TOP_ORIGIN_Y,
} from '../constants';
import type { TerminalGeometry } from '../types';

export function useTerminalGeometry(bot: BotCartridgeData): TerminalGeometry {
  const isProjectManager = bot.role === 'PM';
  const isSeniorPro = bot.role === 'SP';
  const terminalX = bot.terminalX || 0;
  const terminalY = bot.terminalY || 0;
  const terminalWidth = Math.max(TERMINAL_MIN_WIDTH, bot.terminalWidth || TERMINAL_MIN_WIDTH);
  const terminalHeight = Math.max(TERMINAL_MIN_HEIGHT, bot.terminalHeight || TERMINAL_MIN_HEIGHT);
  const terminalFontSize = bot.terminalFontSize || TERMINAL_DEFAULT_FONT_SIZE;
  const terminalLayer = bot.terminalLayer || TERMINAL_BASE_LAYER;
  const terminalOriginX = isSeniorPro ? TERMINAL_SP_ORIGIN_X : TERMINAL_ORIGIN_X;
  const terminalOriginY = isProjectManager
    ? TERMINAL_TOP_ORIGIN_Y
    : isSeniorPro
      ? TERMINAL_SP_ORIGIN_Y
      : TERMINAL_BOTTOM_ORIGIN_Y;
  const lineDx = isSeniorPro ? 14 + terminalX + TERMINAL_ATTACH_Y : terminalX;
  const lineDy = isProjectManager
    ? terminalY
    : isSeniorPro
      ? terminalY
      : TERMINAL_BASE_Y + terminalY + TERMINAL_ATTACH_Y;

  return {
    terminalX,
    terminalY,
    terminalWidth,
    terminalHeight,
    terminalFontSize,
    terminalLayer,
    terminalOriginX,
    terminalOriginY,
    lineLength: Math.max(1, Math.hypot(lineDx, lineDy)),
    lineAngle: Math.atan2(lineDy, lineDx),
  };
}
