const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const { performance } = require('perf_hooks');

// ==========================================
// Constantes e Configuracoes
// ==========================================
const RAIO_TERRA_METROS = 6371000;
const DISTANCIA_LIMITE = 20.0;
const DEG_TO_RAD = Math.PI / 180;
const TAMANHO_CELULA_GRID = 0.0002;

// ==========================================
// Calculo de Distancia (Haversine)
// ==========================================
function calcularDistanciaHaversine(lat1, lon1, lat2, lon2) {
  const dLatDeg = Math.abs(lat2 - lat1);
  if (dLatDeg > 0.0002) return Infinity;

  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;

  const rLat1 = lat1 * DEG_TO_RAD;
  const rLat2 = lat2 * DEG_TO_RAD;

  const sinDLat = Math.sin(dLat * 0.5);
  const sinDLon = Math.sin(dLon * 0.5);

  const a =
    sinDLat * sinDLat +
    Math.cos(rLat1) * Math.cos(rLat2) * sinDLon * sinDLon;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return RAIO_TERRA_METROS * c;
}

// ==========================================
// Parser do Arquivo
// ==========================================
function limpar(str) {
  if (!str) return '';
  return str.replace(/^["']|["']$/g, '').trim();
}

function parseLine(line) {
  const linhaLimpa = line.trim();
  if (!linhaLimpa || linhaLimpa.startsWith('idMonitorado')) {
    return null;
  }

  const parts = linhaLimpa.split(';');
  if (parts.length < 6) return null;

  const id = Number(limpar(parts[0]));
  if (Number.isNaN(id)) return null;

  const faccaoRaw = limpar(parts[1]);
  const faccao = faccaoRaw !== '' ? faccaoRaw : null;

  const timestamp = limpar(parts[2]);
  const lat = parseFloat(limpar(parts[3]));
  const lon = parseFloat(limpar(parts[4]));

  const medidaRaw = limpar(parts[5]).toLowerCase();
  const medidaProtetiva = medidaRaw === 'true' || medidaRaw === '1';

  let restricoes = null;
  if (medidaProtetiva && parts[6]) {
    const rawIds = limpar(parts[6]);
    if (rawIds.length > 0) {
      restricoes = new Set();
      const splitIds = rawIds.split(',');
      for (let i = 0; i < splitIds.length; i++) {
        const numId = Number(limpar(splitIds[i]));
        if (!Number.isNaN(numId)) {
          restricoes.add(numId);
        }
      }
    }
  }

  return {
    id,
    faccao,
    timestamp,
    lat,
    lon,
    medidaProtetiva,
    restricoes,
  };
}

// ==========================================
// Classificacao dos Encontros
// ==========================================
function classificarEncontro(p1, p2) {
  const p1RestringeP2 =
    p1.medidaProtetiva && p1.restricoes && p1.restricoes.has(p2.id);
  const p2RestringeP1 =
    p2.medidaProtetiva && p2.restricoes && p2.restricoes.has(p1.id);

  if (p1RestringeP2 || p2RestringeP1) {
    return 'protetiva';
  }

  const ambosMonitorados = !p1.medidaProtetiva && !p2.medidaProtetiva;

  if (ambosMonitorados && p1.faccao !== null && p1.faccao === p2.faccao) {
    return 'faccao';
  }

  if (ambosMonitorados) {
    return 'generico';
  }

  return null;
}

// ==========================================
// Deteccao com Indexacao Espacial (Grid)
// ==========================================
function avaliarPar(timestamp, p1, p2, resultados) {
  if (p1.id === p2.id) return;

  const tipo = classificarEncontro(p1, p2);
  if (!tipo) return;

  const distancia = calcularDistanciaHaversine(p1.lat, p1.lon, p2.lat, p2.lon);
  if (distancia < DISTANCIA_LIMITE) {
    const [first, second] = p1.id < p2.id ? [p1, p2] : [p2, p1];

    resultados.push({
      tipo: tipo,
      monitoradosEncontro: [first.id, second.id],
      timestamp: timestamp,
      posicoes: {
        [String(first.id)]: { lat: first.lat, lon: first.lon },
        [String(second.id)]: { lat: second.lat, lon: second.lon },
      },
      distanciaMetros: distancia,
    });
  }
}

function processarTimestamp(timestamp, registrosMap, resultados) {
  const pessoas = Array.from(registrosMap.values());
  const total = pessoas.length;
  if (total < 2) return;

  if (total <= 25) {
    for (let i = 0; i < total; i++) {
      for (let j = i + 1; j < total; j++) {
        avaliarPar(timestamp, pessoas[i], pessoas[j], resultados);
      }
    }
    return;
  }

  const grid = new Map();

  for (let i = 0; i < total; i++) {
    const p = pessoas[i];
    const cellX = Math.floor(p.lat / TAMANHO_CELULA_GRID);
    const cellY = Math.floor(p.lon / TAMANHO_CELULA_GRID);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${cellX + dx}:${cellY + dy}`;
        const vizinhos = grid.get(key);
        if (vizinhos) {
          for (let k = 0; k < vizinhos.length; k++) {
            avaliarPar(timestamp, vizinhos[k], p, resultados);
          }
        }
      }
    }

    const cellKey = `${cellX}:${cellY}`;
    let celula = grid.get(cellKey);
    if (!celula) {
      celula = [];
      grid.set(cellKey, celula);
    }
    celula.push(p);
  }
}

// ==========================================
// Leitura e Processamento em Stream
// ==========================================
async function processarDataset(caminhoArquivo) {
  const inicio = performance.now();
  const porTimestamp = new Map();
  let totalLinhas = 0;

  const fileStream = fs.createReadStream(caminhoArquivo, {
    encoding: 'utf8',
    highWaterMark: 64 * 1024,
  });

  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const reg = parseLine(line);
    if (!reg) continue;
    totalLinhas++;

    let mapa = porTimestamp.get(reg.timestamp);
    if (!mapa) {
      mapa = new Map();
      porTimestamp.set(reg.timestamp, mapa);
    }
    mapa.set(reg.id, reg);
  }

  const encontros = [];
  for (const [timestamp, mapa] of porTimestamp.entries()) {
    processarTimestamp(timestamp, mapa, encontros);
  }

  const fim = performance.now();
  return {
    encontros,
    tempoMs: fim - inicio,
    totalLinhas,
  };
}

// ==========================================
// Validacao com Gabarito
// ==========================================
function chaveEncontro(enc) {
  const ids = [...enc.monitoradosEncontro].map(Number).sort((a, b) => a - b);
  return `${enc.timestamp}|${ids[0]}-${ids[1]}|${enc.tipo}`;
}

function validarComGabarito(gerados, esperados) {
  const setEsperados = new Set(esperados.map(chaveEncontro));
  const setGerados = new Set(gerados.map(chaveEncontro));

  let corretos = 0;
  let incorretos = 0;
  let faltantes = 0;

  for (const chave of setGerados) {
    if (setEsperados.has(chave)) {
      corretos++;
    } else {
      incorretos++;
    }
  }

  for (const chave of setEsperados) {
    if (!setGerados.has(chave)) {
      faltantes++;
    }
  }

  return {
    corretos,
    incorretos,
    faltantes,
    totalEsperados: esperados.length,
    score: corretos - incorretos,
    perfeito: incorretos === 0 && faltantes === 0,
  };
}

// ==========================================
// Download dos Datasets
// ==========================================
const BASE_URL = 'https://bucket-projeto-trainee.s3.sa-east-1.amazonaws.com';

function baixarArquivo(url, destino) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destino) && fs.statSync(destino).size > 0) {
      return resolve(false);
    }
    const file = fs.createWriteStream(destino);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          fs.unlink(destino, () => {});
          return reject(new Error(`Erro ${res.statusCode} ao baixar ${url}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(true)));
      })
      .on('error', (err) => {
        fs.unlink(destino, () => {});
        reject(err);
      });
  });
}

// ==========================================
// Execucao Principal
// ==========================================
async function main() {
  const args = process.argv.slice(2);
  const dataDir = path.resolve(process.cwd(), 'data');
  const outputDir = path.resolve(process.cwd(), 'outputs');

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  if (args.length >= 1 && !args[0].startsWith('--')) {
    const inputPath = path.resolve(args[0]);
    const outPath = args[1]
      ? path.resolve(args[1])
      : path.join(outputDir, `output_${path.basename(inputPath, '.txt')}.json`);

    console.log(`Processando ${inputPath}...`);
    const { encontros, tempoMs, totalLinhas } = await processarDataset(inputPath);
    fs.writeFileSync(outPath, JSON.stringify(encontros, null, 2), 'utf8');
    console.log(`Finalizado em ${tempoMs.toFixed(2)} ms | Linhas: ${totalLinhas} | Encontros: ${encontros.length}`);
    return;
  }

  const arquivos = [
    'dataset1.txt',
    'dataset2.txt',
    'dataset3.txt',
    'dataset4.txt',
    'dataset5.txt',
    'dataset6.txt',
    'dataset7.txt',
    'respostas1.json',
    'respostas2.json',
  ];

  if (args.includes('--download')) {
    console.log('Baixando datasets...');
    for (const nome of arquivos) {
      const dest = path.join(dataDir, nome);
      if (fs.existsSync(path.resolve(process.cwd(), nome))) continue;
      try {
        await baixarArquivo(`${BASE_URL}/${nome}`, dest);
      } catch (err) {
        console.warn(`Falha ao baixar ${nome}: ${err.message}`);
      }
    }
  }

  const acharArquivo = (nome) => {
    const p1 = path.join(dataDir, nome);
    if (fs.existsSync(p1)) return p1;
    const p2 = path.resolve(process.cwd(), nome);
    if (fs.existsSync(p2)) return p2;
    return null;
  };

  let somaTempos = 0;
  let contagem = 0;

  for (let i = 1; i <= 7; i++) {
    const nome = `dataset${i}.txt`;
    const caminho = acharArquivo(nome);

    if (!caminho) {
      console.log(`Arquivo nao encontrado: ${nome}`);
      continue;
    }

    const { encontros, tempoMs, totalLinhas } = await processarDataset(caminho);
    somaTempos += tempoMs;
    contagem++;

    const outPath = path.join(outputDir, `output_dataset${i}.json`);
    fs.writeFileSync(outPath, JSON.stringify(encontros, null, 2), 'utf8');

    console.log(
      `✓ ${nome.padEnd(13)} | Linhas: ${String(totalLinhas).padStart(8)} | Encontros: ${String(encontros.length).padStart(4)} | Tempo: ${tempoMs.toFixed(2).padStart(8)} ms`
    );

    const gabarito = acharArquivo(`respostas${i}.json`);
    if (gabarito) {
      const dadosGabarito = JSON.parse(fs.readFileSync(gabarito, 'utf8'));
      const r = validarComGabarito(encontros, dadosGabarito);
      console.log(
        `  └─ [Gabarito respostas${i}.json] Acertos: ${r.corretos}/${r.totalEsperados} | Incorretos: ${r.incorretos} | Score: ${r.score}`
      );
    }
  }

  if (contagem > 0) {
    console.log('\n----------------------------------------------');
    console.log(`Datasets processados: ${contagem}`);
    console.log(`Tempo total         : ${somaTempos.toFixed(2)} ms`);
    console.log(`Tempo medio/dataset : ${(somaTempos / contagem).toFixed(2)} ms`);
    console.log('----------------------------------------------');
  }
}

module.exports = {
  calcularDistanciaHaversine,
  parseLine,
  classificarEncontro,
  processarDataset,
  validarComGabarito,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro na execucao:', err);
    process.exit(1);
  });
}