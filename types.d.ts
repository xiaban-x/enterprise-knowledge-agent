declare module "pdf-parse" {
  interface PDFData {
    text: string;
    numpages: number;
    info: any;
    metadata: any;
  }
  function pdfParse(buffer: Buffer): Promise<PDFData>;
  export default pdfParse;
}

declare module "jszip" {
  interface JSZipObject {
    async(type: "text"): Promise<string>;
    async(type: "arraybuffer"): Promise<ArrayBuffer>;
    async(type: "uint8array"): Promise<Uint8Array>;
  }

  interface JSZip {
    file(path: string): JSZipObject | null;
    loadAsync(data: Buffer | ArrayBuffer | Uint8Array): Promise<JSZip>;
  }

  const JSZip: {
    new (): JSZip;
    loadAsync(data: Buffer | ArrayBuffer | Uint8Array): Promise<JSZip>;
  };

  export default JSZip;
}
