# Desafio Técnico — Detecção de Encontros (Spacecom Monitoramento)

Solução de alta performance desenvolvida em **Node.js (JavaScript)** sem dependências externas para processamento de dados de geolocalização e detecção de encontros físicos entre monitorados (tornozeleiras eletrônicas) e vítimas com medidas protetivas (rastreadores portáteis).

## 1. Arquitetura e Lógica da Solução

O problema consiste em identificar pares de indivíduos que, no **exato mesmo timestamp** (intervalos de 5 segundos), estejam a uma distância estritamente menor que **20 metros**, classificando o encontro em três categorias (`protetiva`, `faccao` ou `generico`).

Para maximizar a pontuação (`Score = soma_ec - soma_ei`) e vencer no **critério de desempate (menor tempo médio de execução)**, a solução foi projetada em 4 pilares:

### 1.1. Leitura em Stream (`readline` + `fs.createReadStream`)
Em vez de carregar arquivos `.txt` inteiros na memória com `fs.readFileSync` e `split('\n')` (o que pode causar alto consumo de RAM e *Garbage Collection pauses* em datasets grandes), utilizamos *streams* com buffer de 64 KB. Cada linha é convertida em uma estrutura leve e indexada por `timestamp`.

### 1.2. Busca de Restrições em $O(1)$ com `Set`
Para vítimas com medida protetiva (`medidaProtetiva === true`), a lista `idsRestricaoMedida` (ex.: `"1,2,3,...n"`) é convertida durante o parse em um `Set<number>`. Assim, verificar se um monitorado é agressor restrito daquela vítima custa tempo constante $O(1)$ em vez de busca linear $O(K)$.

### 1.3. Indexação Espacial com *Spatial Hashing* (Grid 2D) — De $O(N^2)$ para $O(N)$
A abordagem ingênua compara todos os indivíduos presentes em um mesmo timestamp entre si ($\frac{N(N-1)}{2}$ comparações, complexidade $O(N^2)$).
Para evitar cálculos trigonométricos desnecessários entre pessoas distantes:
1. Dividimos o espaço geográfico em uma grade (*Spatial Grid*) onde cada célula possui `0.0002° x 0.0002°` (aproximadamente **22,2 metros** de lado).
2. Dois indivíduos a menos de 20 metros de distância obrigatoriamente estarão **na mesma célula** ou em uma das **8 células imediatamente vizinhas**.
3. Ao inserir cada indivíduo no grid daquele timestamp, comparamos sua posição apenas com os indivíduos já presentes nessas 9 células adjacentes.
4. Além disso, aplicamos um *Bounding Box pré-filtro* (`Math.abs(lat2 - lat1) > 0.0002`) antes de invocar `Math.sin`, `Math.cos` e `Math.atan2` da Fórmula de Haversine.
5. Como cada pessoa é testada apenas contra quem já está no grid antes de ser inserida, **cada par é avaliado no máximo uma única vez**, garantindo unicidade sem precisar de um `Set` adicional de pares visitados.

| Abordagem | Complexidade por Timestamp | Operações de Haversine | Uso de Memória |
| :--- | :--- | :--- | :--- |
| Força Bruta (Todos contra Todos) | $O(N^2)$ | $\frac{N(N-1)}{2}$ | Baixo |
| **Spatial Hashing (Nossa Solução)** | **$O(N)$ médio** | **Apenas vizinhos em raio < 22m** | **Baixo e Linear $O(N)$** |

### 1.4. Fórmula de Haversine e Regras de Negócio
A distância é calculada exatamente conforme especificado:
- Raio da Terra $R = 6.371.000\text{ m}$
- Condição de encontro: `distanciaMetros < 20.0`
- Classificação por par no mesmo timestamp:
  1. **`protetiva`**: Um dos envolvidos possui `medidaProtetiva = true` e o ID do outro consta em seu conjunto `idsRestricaoMedida`.
  2. **`faccao`**: Ambos são monitorados (`medidaProtetiva = false`) e possuem o mesmo `faccaoMonitorado` (não vazio).
  3. **`generico`**: Encontro entre dois monitorados que não se enquadram nas restrições anteriores.
- O script também conta com uma rotina de **auto-calibração (`autoCalibrarConfig`)** que valida automaticamente contra `respostas1.json` e `respostas2.json` para assegurar 100% de aderência às convenções do gabarito oficial.

## 2. Pré-requisitos e Como Executar

### Pré-requisitos
- **Node.js** (versão 16 ou superior recomendada). Não há necessidade de `npm install`, pois o projeto utiliza exclusivamente módulos nativos do Node.js (`fs`, `path`, `readline`, `https`, `perf_hooks`) para máxima velocidade e zero sobrecarga.

### Opção 1: Baixar automaticamente os datasets do S3 e processar todos
No terminal, dentro da pasta do projeto, execute:

```bash
node detector_encontros.js --download
```

O script irá:
1. Baixar `dataset1.txt` a `dataset7.txt` e os gabaritos `respostas1.json` e `respostas2.json` para a pasta `./data/`.
2. Validar automaticamente a precisão (`soma_ec`, `soma_ei` e `Score`) nos datasets 1 e 2.
3. Gerar os arquivos JSON de resposta para todos os 7 datasets na pasta `./outputs/` (`output_dataset1.json` até `output_dataset7.json`) exibindo o tempo de execução em milissegundos de cada um.

### Opção 2: Executar com arquivos já baixados localmente
Coloque os arquivos `dataset1.txt` ... `dataset7.txt` (e `respostas1.json`, `respostas2.json`) na mesma pasta do script (ou dentro de `./data/`) e execute:

```bash
node detector_encontros.js
```

### Opção 3: Processar um único arquivo específico via linha de comando
```bash
node detector_encontros.js caminho/para/dataset3.txt caminho/para/saida3.json
```

## 3. Estrutura do Output Gerado

Cada arquivo gerado em `./outputs/output_datasetX.json` segue estritamente o contrato JSON especificado:

```json
[
  {
    "tipo": "faccao",
    "monitoradosEncontro": [40, 44],
    "timestamp": "2024-01-01 00:01:50",
    "posicoes": {
      "40": { "lat": -10.07996, "lon": -37.08384 },
      "44": { "lat": -10.07987, "lon": -37.08389 }
    },
    "distanciaMetros": 11.406788673336607
  }
]
```
