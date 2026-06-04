#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const { generatePdf } = require('./src/generator');
const { closeAllBrowsers } = require('./src/browser');
const { StatsTracker } = require('./src/stats');
const { Progress } = require('./src/progress');

function printStats({ elapsed, peakMemMB, endMemMB, cpu, pages, chunks, inputBytes, outputBytes }) {
  const sep = chalk.gray('─'.repeat(44));
  console.log('\n' + sep);
  console.log(chalk.bold('  Generation Stats'));
  console.log(sep);
  console.log(`  ${'Time'.padEnd(18)} ${chalk.yellow(elapsed + 's')}`);
  console.log(`  ${'Pages'.padEnd(18)} ${chalk.yellow(pages)}`);
  if (chunks > 1) {
    console.log(`  ${'Chunks'.padEnd(18)} ${chalk.yellow(chunks)}`);
  }
  console.log(`  ${'Peak Memory'.padEnd(18)} ${chalk.yellow(peakMemMB + ' MB')}`);
  console.log(`  ${'End Memory (RSS)'.padEnd(18)} ${chalk.yellow(endMemMB + ' MB')}`);
  console.log(`  ${'CPU (end)'.padEnd(18)} ${chalk.yellow(cpu + '%')}`);
  console.log(`  ${'Input size'.padEnd(18)} ${chalk.yellow((inputBytes / 1024 / 1024).toFixed(2) + ' MB')}`);
  console.log(`  ${'Output size'.padEnd(18)} ${chalk.yellow((outputBytes / 1024).toFixed(1) + ' KB')}`);
  console.log(sep + '\n');
}

program
  .name('html-to-pdf')
  .description('Convert an HTML file to a PDF document')
  .version('1.0.0')
  .argument('<input>', 'Path to the HTML input file')
  .option('-o, --output <path>', 'Output PDF file path (default: input name with .pdf)')
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

    const tracker = new StatsTracker();
    // Start with 1; generator updates progress.total once it knows the real chunk count
    const progress = new Progress(1);

    try {
      const { buffer, pages, chunks } = await generatePdf(
        htmlContent,
        {
          format: opts.format,
          printBackground: opts.background !== false,
          displayHeaderFooter: !!opts.headerFooter,
          margin: {
            top: opts.marginTop,
            bottom: opts.marginBottom,
            left: opts.marginLeft,
            right: opts.marginRight,
          },
        },
        progress
      );

      fs.writeFileSync(outputPath, buffer);
      const stats = tracker.stop();

      console.log(chalk.green(`\nPDF written → ${outputPath}`));
      printStats({
        elapsed: stats.elapsedSec,
        peakMemMB: stats.peakMemMB,
        endMemMB: stats.endMemMB,
        cpu: stats.cpuPercent,
        pages,
        chunks,
        inputBytes: Buffer.byteLength(htmlContent),
        outputBytes: buffer.length,
      });
    } catch (err) {
      tracker.stop();
      console.error(chalk.red(`Error: ${err.message}`));
      process.exitCode = 1;
    } finally {
      await closeAllBrowsers();
    }
  });

program.parse();
