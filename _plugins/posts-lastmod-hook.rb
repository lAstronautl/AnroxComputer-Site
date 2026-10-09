#!/usr/bin/env ruby
#
# Check for changed posts

Jekyll::Hooks.register :site, :after_init do |site|
  begin
    log = `git log --name-only --no-merges --pretty=format:"%x00%ad" --date=iso`
  rescue SystemCallError
    log = ''
  end

  lastmods = {}
  current_date = nil

  log.each_line do |line|
    line = line.chomp
    if line.start_with?("\x00")
      current_date = line.delete_prefix("\x00")
    elsif !line.empty? && current_date
      lastmods[line] ||= current_date
    end
  end

  site.data['__posts_lastmod'] = lastmods
end

Jekyll::Hooks.register :posts, :post_init do |post|
  lastmods = post.site.data['__posts_lastmod'] || {}
  relative_path = post.relative_path.to_s.tr('\\', '/').sub(%r!\A/+!, '')
  lastmod_date = lastmods[relative_path]

  post.data['last_modified_at'] = lastmod_date if lastmod_date
end
