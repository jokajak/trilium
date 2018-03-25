"use strict";

import noteDetail from '../services/note_detail.js';

const $showDialogButton = $("#show-source-button");
const $dialog = $("#note-source-dialog");
const $noteSource = $("#note-source");

function showDialog() {
    glob.activeDialog = $dialog;

    $dialog.dialog({
        modal: true,
        width: 800,
        height: 500
    });

    const noteText = noteDetail.getCurrentNote().detail.content;

    $noteSource.text(formatHtml(noteText));
}

function formatHtml(str) {
    const div = document.createElement('div');
    div.innerHTML = str.trim();

    return formatNode(div, 0).innerHTML.trim();
}

function formatNode(node, level) {
    const indentBefore = new Array(level++ + 1).join('  ');
    const indentAfter  = new Array(level - 1).join('  ');
    let textNode;

    for (let i = 0; i < node.children.length; i++) {
        textNode = document.createTextNode('\n' + indentBefore);
        node.insertBefore(textNode, node.children[i]);

        formatNode(node.children[i], level);

        if (node.lastElementChild === node.children[i]) {
            textNode = document.createTextNode('\n' + indentAfter);
            node.appendChild(textNode);
        }
    }

    return node;
}

$(document).bind('keydown', 'ctrl+u', e => {
    showDialog();

    e.preventDefault();
});

$showDialogButton.click(showDialog);

export default {
    showDialog
};