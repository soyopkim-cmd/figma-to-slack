figma.showUI(__html__, { width: 360, height: 520, title: "Figma to Slack" });

// 이 파일에 저장된 fileKey 불러오기
var _fileName = figma.root.name;
figma.clientStorage.getAsync('fileKey__' + _fileName).then(function(fk) {
  figma.ui.postMessage({ type: 'stored-filekey', fileKey: fk || null, fileName: _fileName });
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
  
  var autoNodeId = null;
  if (selection.length > 0) {
    var firstNode = selection[0];
    var targetNode = (firstNode.type === 'SECTION' && firstNode.children.length > 0)
      ? firstNode.children[0]
      : firstNode;
    autoNodeId = targetNode.id.replace(':', '-');
  }

  var fk = figma.fileKey;
  figma.ui.postMessage({ type: 'debug-filekey', value: String(fk) });

  figma.ui.postMessage({
    type: 'selection',
    frames: frames,
    sections: sections,
    fileKey: fk || null,
    autoNodeId: autoNodeId
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
        
        if (fileUrl) {
          var firstNodeId = nodeIds[0].replace(/:/g, '-');
          nodeUrl = fileUrl + '?node-id=' + firstNodeId;
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
