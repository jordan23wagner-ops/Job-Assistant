document.addEventListener('DOMContentLoaded', function() {
  chrome.storage.local.get('tailoredResumeHtml', function(data) {
    var el = document.getElementById('resume-content');
    if (data.tailoredResumeHtml) {
      el.innerHTML = data.tailoredResumeHtml;
    } else {
      el.innerHTML = '<p style="color:#888; text-align:center; padding-top:2in;">No resume found. Generate a tailored resume from the Alicia AI side panel first.</p>';
    }
  });
  document.getElementById('print-btn').addEventListener('click', function() {
    window.print();
  });
});
