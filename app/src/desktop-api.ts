export interface AgentsCoordinatorDesktopApi {
  isDesktop: true;
  closeApp: () => Promise<void>;
  chooseProjectFolder: () => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;
}

declare global {
  interface Window {
    agentsCoordinatorDesktop?: AgentsCoordinatorDesktopApi;
  }
}

export function getDesktopApi() {
  return window.agentsCoordinatorDesktop;
}
