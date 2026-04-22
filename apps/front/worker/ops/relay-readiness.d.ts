export function loadJson(path: string): any;
export function evaluateDrill(spec: any, drill: any): {
  alert_ids: string[];
  route_ids: string[];
};
export function validateAlertCatalog(spec: any, drills: any[]): string[];
export function validateReadinessManifest(
  spec: any,
  drills: any[],
  manifest: any,
  options: { target: string; wranglerText: string },
): string[];
