declare module "main/home-window" {
    export function findHomeWindow():
        | {
              browserWindow: Electron.BrowserWindow;
          }
        | undefined;
}
