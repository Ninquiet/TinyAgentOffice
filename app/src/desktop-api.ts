export interface AgentsCoordinatorDesktopApi {
  isDesktop: true;
  closeApp: () => Promise<void>;
  chooseProjectFolder: () => Promise<string | null>;
}

declare global {
  interface Window {
    agentsCoordinatorDesktop?: AgentsCoordinatorDesktopApi;
  }
}

export function getDesktopApi() {
  return window.agentsCoordinatorDesktop;
}
