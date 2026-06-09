figma.showUI(__html__, { width: 360, height: 490, title: "Figma to Slack" });

// 이 파일에 저장된 fileKey 불러오기 (오염된 URL이 저장돼 있으면 키만 추출해서 정리)
var _fileName = figma.root.name;
figma.clientStorage.getAsync('fileKey__' + _fileName).then(function(fk) {
  var cleanKey = null;
  if (fk) {
    var m = String(fk).match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/);
    if (m) {
      cleanKey = m[1];
    } else {
      var k = String(fk).split(/[/?&#]/)[0];
      cleanKey = /^[a-zA-Z0-9]{10,40}$/.test(k) ? k : null;
    }
    if (cleanKey && cleanKey !== fk) {
      // 저장값이 오염됐으면 정제된 키로 덮어씀
      figma.clientStorage.setAsync('fileKey__' + _fileName, cleanKey);
    } else if (!cleanKey && fk) {
      // 유효하지 않은 키(너무 길거나 형식 오류) → 삭제
      figma.clientStorage.deleteAsync('fileKey__' + _fileName);
    }
  }
  figma.ui.postMessage({ type: 'stored-filekey', fileKey: cleanKey || null, fileName: _fileName });
});

function getSelection() {
  var selection = figma.currentPage.selection;
  
  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'no-selection' });
    return;
  }
  
  var frames = [];
  var sections = [];
  
  for (var i = 0; i < selection.length; i++) {
    var node = selection[i];
    
    if (node.type === 'SECTION') {
      var childFrames = [];
      for (var j = 0; j < node.children.length; j++) {
        var child = node.children[j];
        if (child.type === 'FRAME' || child.type === 'COMPONENT' || child.type === 'INSTANCE' || child.type === 'GROUP') {
          childFrames.push({ id: child.id, name: child.name });
        }
      }
      if (childFrames.length > 0) {
        sections.push({
          id: node.id,
          name: node.name,
          children: childFrames
        });
      }
    } else {
      frames.push({ id: node.id, name: node.name });
    }
  }
  
  var fk = figma.fileKey;
  if (fk) {
    figma.clientStorage.setAsync('fileKey__' + figma.root.name, fk);
  }

  figma.ui.postMessage({
    type: 'selection',
    frames: frames,
    sections: sections,
    fileKey: fk || null
  });
}

figma.ui.onmessage = function(msg) {
  if (msg.type === 'get-selection') {
    getSelection();
  }

  if (msg.type === 'save-url') {
    figma.clientStorage.setAsync('figmaFileUrl', msg.url);
  }

  if (msg.type === 'save-filekey') {
    figma.clientStorage.setAsync('fileKey__' + figma.root.name, msg.fileKey);
  }

  if (msg.type === 'export-frames') {
    var nodeIds = msg.nodeIds;
    var fileUrl = msg.fileUrl;
    var linkNodeId = msg.linkNodeId || null;
    var displayName = msg.displayName;
    var threadUrl = msg.threadUrl;
    var exportPromises = [];
    var allFrames = [];
    
    for (var i = 0; i < nodeIds.length; i++) {
      (function(nodeId) {
        var node = figma.getNodeById(nodeId);
        if (node) {
          exportPromises.push(
            node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } })
              .then(function(bytes) {
                allFrames.push({
                  bytes: Array.from(bytes),
                  name: node.name,
                  nodeId: node.id
                });
              })
          );
        }
      })(nodeIds[i]);
    }
    
    Promise.all(exportPromises)
      .then(function() {
        var nodeUrl = '';
        
        if (!displayName) {
          displayName = allFrames.length > 1 ? allFrames.length + '개 프레임' : allFrames[0].name;
        }
        
        if (fileUrl && linkNodeId) {
          nodeUrl = fileUrl + '?node-id=' + String(linkNodeId).replace(':', '-');
        } else if (fileUrl) {
          nodeUrl = fileUrl;
        }
        
        figma.ui.postMessage({
          type: 'export-done',
          frames: allFrames,
          nodeUrl: nodeUrl,
          displayName: displayName,
          threadUrl: threadUrl
        });
      })
      .catch(function(err) {
        figma.ui.postMessage({ type: 'error', message: '추출 실패: ' + err.message });
      });
  }
};

getSelection();
figma.on('selectionchange', getSelection);
