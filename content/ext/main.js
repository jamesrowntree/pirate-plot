'use strict';
(function () {
  var worksheet = null;
  var CATEGORY_FIELD = 'captain_name';
  var VALUE_FIELD = 'engagement_count';

  window.onload = function () {
    renderFallback();
    tableau.extensions.initializeAsync().then(function () {
      worksheet = tableau.extensions.worksheetContent.worksheet;
      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, render);
      render();
    }, function (err) {
      renderMessage('Init error: ' + describeError(err));
    });
  };

  function render() {
    if (!worksheet) return;
    worksheet.getSummaryDataAsync().then(renderPiratePlot, function (err) {
      renderMessage('Data error: ' + describeError(err));
    });
  }

  // ---- data shaping ----

  function findColumnIndex(columns, nameFragments) {
    var frags = Array.isArray(nameFragments) ? nameFragments : [nameFragments];
    for (var f = 0; f < frags.length; f++) {
      var frag = frags[f].toLowerCase();
      for (var i = 0; i < columns.length; i++) {
        if (columns[i].fieldName.toLowerCase().indexOf(frag) !== -1) return i;
      }
    }
    return -1;
  }

  function groupData(data) {
    var columns = data.columns;
    var rows = data.data;
    var catIdx = findColumnIndex(columns, [CATEGORY_FIELD, 'captain']);
    var valIdx = findColumnIndex(columns, [VALUE_FIELD, 'engagement']);
    if (catIdx === -1 || valIdx === -1) return null;

    var groups = {};
    var order = [];
    var unparsed = 0;
    rows.forEach(function (row) {
      var cat = row[catIdx].formattedValue;
      var raw = row[valIdx].value;
      var val = typeof raw === 'number' ? raw : parseFloat(row[valIdx].formattedValue);
      if (isNaN(val)) { unparsed++; return; }
      if (!groups[cat]) { groups[cat] = []; order.push(cat); }
      groups[cat].push(val);
    });

    if (unparsed > 0) {
      console.log('Pirate Plot: ' + unparsed + ' row(s) unparsed for ' + VALUE_FIELD);
    }

    return { groups: groups, order: order };
  }

  function stats(values) {
    var n = values.length;
    var mean = values.reduce(function (a, b) { return a + b; }, 0) / n;
    var variance = values.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / Math.max(n - 1, 1);
    var sd = Math.sqrt(variance);
    var se = sd / Math.sqrt(n);
    var ci = 1.96 * se;
    return { n: n, mean: mean, sd: sd, ci: ci, min: Math.min.apply(null, values), max: Math.max.apply(null, values) };
  }

  // Gaussian KDE, returns {ys, densities} sampled over [min,max]
  function kde(values, samples) {
    var n = values.length;
    var sd = stats(values).sd || 1;
    var bandwidth = 1.06 * sd * Math.pow(n, -0.2) || 1;
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var pad = (max - min) * 0.15 || 1;
    var lo = min - pad, hi = max + pad;
    var step = (hi - lo) / (samples - 1);
    var ys = [];
    var densities = [];
    for (var s = 0; s < samples; s++) {
      var y = lo + s * step;
      var sum = 0;
      for (var i = 0; i < n; i++) {
        var u = (y - values[i]) / bandwidth;
        sum += Math.exp(-0.5 * u * u);
      }
      var density = sum / (n * bandwidth * Math.sqrt(2 * Math.PI));
      ys.push(y);
      densities.push(density);
    }
    return { ys: ys, densities: densities };
  }

  // ---- rendering ----

  var PALETTE = ['#4C6E8C', '#C4703A', '#5E8C5A', '#9A5A8C', '#C4A63A', '#3A8CA6', '#8C5A3A', '#5A5A8C'];

  function renderPiratePlot(data) {
    var root = clearRoot();
    var shaped = groupData(data);
    if (!shaped || shaped.order.length === 0) {
      var p = document.createElement('p');
      p.textContent = 'No ' + CATEGORY_FIELD + ' / ' + VALUE_FIELD + ' data on Detail yet.';
      root.appendChild(p);
      return;
    }
    drawChart(root, shaped);
  }

  function drawChart(root, shaped) {
    var order = shaped.order;
    var groups = shaped.groups;

    var wrap = document.createElement('div');
    wrap.style.width = '100%';
    wrap.style.height = '100%';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    root.appendChild(wrap);

    var title = document.createElement('div');
    title.textContent = VALUE_FIELD + ' by ' + CATEGORY_FIELD + ' — pirate plot';
    title.style.fontSize = '13px';
    title.style.fontWeight = '600';
    title.style.padding = '4px 8px';
    title.style.color = '#333';
    wrap.appendChild(title);

    var canvasHolder = document.createElement('div');
    canvasHolder.style.flex = '1';
    canvasHolder.style.position = 'relative';
    canvasHolder.style.minHeight = '0';
    wrap.appendChild(canvasHolder);

    var canvas = document.createElement('canvas');
    canvasHolder.appendChild(canvas);

    function draw() {
      var width = canvasHolder.clientWidth || 600;
      var height = canvasHolder.clientHeight || 400;
      var dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      var ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      var margin = { top: 16, right: 16, bottom: 42, left: 52 };
      var plotW = width - margin.left - margin.right;
      var plotH = height - margin.top - margin.bottom;
      if (plotW <= 0 || plotH <= 0) return;

      var allValues = [];
      order.forEach(function (cat) { allValues = allValues.concat(groups[cat]); });
      var globalMin = Math.min.apply(null, allValues);
      var globalMax = Math.max.apply(null, allValues);
      var padY = (globalMax - globalMin) * 0.1 || 1;
      var yMin = Math.min(0, globalMin - padY);
      var yMax = globalMax + padY;

      function yScale(v) { return margin.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

      var bandWidth = plotW / order.length;

      // y-axis gridlines + labels
      ctx.strokeStyle = '#e6e6e6';
      ctx.fillStyle = '#666';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      var ticks = 5;
      for (var t = 0; t <= ticks; t++) {
        var v = yMin + (t / ticks) * (yMax - yMin);
        var y = yScale(v);
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(margin.left + plotW, y);
        ctx.stroke();
        ctx.fillText(v.toFixed(0), margin.left - 6, y);
      }

      order.forEach(function (cat, idx) {
        var values = groups[cat];
        var s = stats(values);
        var color = PALETTE[idx % PALETTE.length];
        var centerX = margin.left + bandWidth * idx + bandWidth / 2;
        var violinHalfWidth = bandWidth * 0.32;

        // --- violin (density silhouette), left half ---
        var kd = kde(values, 40);
        var maxDensity = Math.max.apply(null, kd.densities) || 1;
        ctx.fillStyle = hexWithAlpha(color, 0.28);
        ctx.beginPath();
        for (var i = 0; i < kd.ys.length; i++) {
          var yy = yScale(kd.ys[i]);
          var w = (kd.densities[i] / maxDensity) * violinHalfWidth;
          var xx = centerX - w;
          if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        }
        for (var j = kd.ys.length - 1; j >= 0; j--) {
          var yy2 = yScale(kd.ys[j]);
          ctx.lineTo(centerX, yy2);
        }
        ctx.closePath();
        ctx.fill();

        // --- raw jittered points, right side ---
        ctx.fillStyle = hexWithAlpha(color, 0.55);
        values.forEach(function (v) {
          var jitter = (Math.random() - 0.5) * (bandWidth * 0.5);
          var px = centerX + bandWidth * 0.18 + jitter * 0.5;
          var py = yScale(v);
          ctx.beginPath();
          ctx.arc(px, py, 2, 0, Math.PI * 2);
          ctx.fill();
        });

        // --- confidence interval band around mean ---
        var ciTop = yScale(s.mean + s.ci);
        var ciBot = yScale(s.mean - s.ci);
        ctx.fillStyle = hexWithAlpha(color, 0.9);
        ctx.fillRect(centerX - 3, ciTop, 6, Math.max(ciBot - ciTop, 1));

        // --- mean bar (horizontal tick spanning band) ---
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(centerX - violinHalfWidth, yScale(s.mean));
        ctx.lineTo(centerX + bandWidth * 0.3, yScale(s.mean));
        ctx.stroke();

        // --- category label ---
        ctx.fillStyle = '#333';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.save();
        var labelY = margin.top + plotH + 6;
        ctx.translate(centerX, labelY);
        var label = cat.length > 14 ? cat.slice(0, 13) + '…' : cat;
        ctx.fillText(label, 0, 0);
        ctx.restore();
      });

      // axis line
      ctx.strokeStyle = '#999';
      ctx.beginPath();
      ctx.moveTo(margin.left, margin.top);
      ctx.lineTo(margin.left, margin.top + plotH);
      ctx.lineTo(margin.left + plotW, margin.top + plotH);
      ctx.stroke();
    }

    draw();
    window.addEventListener('resize', draw);
  }

  function hexWithAlpha(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function renderFallback() {
    var root = clearRoot();
    var p = document.createElement('p');
    p.textContent = 'Loading pirate plot...';
    p.style.fontFamily = 'sans-serif';
    p.style.color = '#666';
    root.appendChild(p);
  }

  function renderMessage(text) {
    var root = clearRoot();
    var p = document.createElement('p');
    p.textContent = text;
    root.appendChild(p);
  }

  function clearRoot() {
    var el = document.getElementById('content');
    while (el.firstChild) el.removeChild(el.firstChild);
    el.style.display = 'block';
    return el;
  }

  function describeError(err) {
    return (err && err.message) ? err.message : String(err);
  }
})();
