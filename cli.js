#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const { generatePdf } = require('./src/generator');
const { closeBrowser } = require('./src/browser');

program
  .name('html-to-pdf')
  .description('Convert an HTML file to a PDF document')
  .version('1.0.0')
  .argument('<input>', 'Path to the HTML input file')
  .option('-o, --output <path>', 'Output PDF file path (default: same name as input with .pdf)')
  .option('-f, --format <format>', 'Page format: A4, A3, Letter, Legal', 'A4')
  .option('--margin-top <size>', 'Top margin (CSS units)', '20mm')
  .option('--margin-bottom <size>', 'Bottom margin (CSS units)', '20mm')
  .option('--margin-left <size>', 'Left margin (CSS units)', '15mm')
  .option('--margin-right <size>', 'Right margin (CSS units)', '15mm')
  .option('--no-background', 'Skip printing background graphics')
  .option('--header-footer', 'Enable default header and footer')
  .action(async (input, opts) => {
    const inputPath = path.resolve(input);

    if (!fs.existsSync(inputPath)) {
      console.error(chalk.red(`Error: File not found: ${inputPath}`));
      process.exit(1);
    }

    const outputPath = opts.output
      ? path.resolve(opts.output)
      : inputPath.replace(/\.html?$/i, '') + '.pdf';

    const htmlContent = fs.readFileSync(inputPath, 'utf8');

    console.log(chalk.cyan(`Input:  ${inputPath}`));
    console.log(chalk.cyan(`Output: ${outputPath}`));
    console.log(chalk.cyan(`Format: ${opts.format}`));
    console.log(chalk.gray('Generating PDF...'));

    const start = Date.now();

    try {
      const pdfBuffer = await generatePdf(htmlContent, {
        format: opts.format,
        printBackground: opts.background !== false,
        displayHeaderFooter: !!opts.headerFooter,
        margin: {
          top: opts.marginTop,
          bottom: opts.marginBottom,
          left: opts.marginLeft,
          right: opts.marginRight,
        },
      });

      fs.writeFileSync(outputPath, pdfBuffer);

      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      const sizeKb = (pdfBuffer.length / 1024).toFixed(1);
      console.log(chalk.green(`Done in ${elapsed}s — ${sizeKb} KB → ${outputPath}`));
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exitCode = 1;
    } finally {
      await closeBrowser();
    }
  });

program.parse();
