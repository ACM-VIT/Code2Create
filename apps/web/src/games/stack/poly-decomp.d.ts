declare module "poly-decomp" {
  interface PolyDecomp {
    quickDecomp(polygon: number[][]): number[][][];
    makeCCW(polygon: number[][]): boolean;
    removeCollinearPoints(polygon: number[][], precision?: number): number;
    removeDuplicatePoints(polygon: number[][], precision?: number): void;
  }

  const decomp: PolyDecomp;
  export default decomp;
}
