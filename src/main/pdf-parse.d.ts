declare module 'pdf-parse' {
  const parse: (data: Buffer) => Promise<{ numpages: number; text: string }>
  export = parse
}
